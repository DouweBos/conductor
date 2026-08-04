/**
 * Tests for the streaming device-input system: protocol decode, the router's
 * pointer-buffering (tap vs drag vs multitouch), coordinate/keymap translation
 * in the backends, and the WebSocket server handshake + move coalescing.
 *
 * All device-free — the router talks to a recording backend, and coord tests
 * use MockIOSDriver.
 */
import { WebSocket } from 'ws';
import { TestSuite, assert } from './runner.js';
import { InputRouter } from '../src/daemon/input-router.js';
import type { InputBackend, NormPath } from '../src/daemon/input-backends.js';
import { iosBackend } from '../src/daemon/input-backends.js';
import { startInputServer } from '../src/daemon/input-server.js';
import { decodeClientFrame, type InputCapabilities } from '../src/daemon/input-protocol.js';
import { MockIOSDriver } from './mock-driver.js';

interface Rec {
  method: string;
  args: unknown[];
}

/** Recording backend that captures normalized calls (no coord translation). */
function recordingBackend(): { backend: InputBackend; calls: Rec[] } {
  const calls: Rec[] = [];
  const backend: InputBackend = {
    platform: 'ios',
    capabilities(liveDrag): InputCapabilities {
      return {
        touch: true,
        drag: true,
        multitouch: true,
        buttons: ['home', 'lock'],
        keyboard: true,
        text: true,
        tvRemote: false,
        springboard: true,
        liveDrag,
        binaryPointer: false,
        coord: 'normalized',
      };
    },
    async tap(nx, ny, d) {
      calls.push({ method: 'tap', args: [nx, ny, d] });
    },
    async gesture(paths: NormPath[]) {
      calls.push({ method: 'gesture', args: [paths] });
    },
    async swipe(a, b, c, d, e) {
      calls.push({ method: 'swipe', args: [a, b, c, d, e] });
    },
    async text(v) {
      calls.push({ method: 'text', args: [v] });
    },
    async key(code, opts) {
      calls.push({ method: 'key', args: [code, opts] });
    },
    async button(name, hold) {
      calls.push({ method: 'button', args: [name, hold] });
    },
  };
  return { backend, calls };
}

export const inputStreaming = new TestSuite('input streaming');

// ── Protocol decode ────────────────────────────────────────────────────────

inputStreaming.test('decodeClientFrame accepts known frame types', async () => {
  const f = decodeClientFrame('{"t":"pointer","phase":"down","x":0.5,"y":0.5}');
  assert(f !== null && f.t === 'pointer', 'expected a pointer frame');
});

inputStreaming.test('decodeClientFrame rejects malformed / unknown', async () => {
  assert(decodeClientFrame('not json') === null, 'malformed json should be null');
  assert(decodeClientFrame('{"t":"bogus"}') === null, 'unknown type should be null');
  assert(decodeClientFrame('42') === null, 'non-object should be null');
});

// ── Router: pointer buffering ────────────────────────────────────────────────

inputStreaming.test('down+up at one point → tap', async () => {
  const { backend, calls } = recordingBackend();
  const r = new InputRouter(backend);
  await r.dispatch({ t: 'pointer', phase: 'down', x: 0.5, y: 0.5 });
  await r.dispatch({ t: 'pointer', phase: 'up', x: 0.5, y: 0.5 });
  assert(calls.length === 1 && calls[0].method === 'tap', `expected one tap, got ${JSON.stringify(calls)}`);
  assert(calls[0].args[0] === 0.5 && calls[0].args[1] === 0.5, 'tap coords wrong');
});

inputStreaming.test('down+move+up → single gesture with 3 steps and dt', async () => {
  const { backend, calls } = recordingBackend();
  let t = 1000;
  const r = new InputRouter(backend, { now: () => t });
  await r.dispatch({ t: 'pointer', phase: 'down', x: 0.1, y: 0.1 });
  t = 1016;
  await r.dispatch({ t: 'pointer', phase: 'move', x: 0.5, y: 0.5 });
  t = 1032;
  await r.dispatch({ t: 'pointer', phase: 'up', x: 0.9, y: 0.9 });
  assert(calls.length === 1 && calls[0].method === 'gesture', 'expected one gesture');
  const paths = calls[0].args[0] as NormPath[];
  assert(paths.length === 1, 'expected one finger path');
  assert(paths[0].steps.length === 3, `expected 3 steps, got ${paths[0].steps.length}`);
  assert(paths[0].steps[1].tMs === 16, `expected dt 16ms, got ${paths[0].steps[1].tMs}`);
});

inputStreaming.test('two concurrent fingers → gesture with 2 paths', async () => {
  const { backend, calls } = recordingBackend();
  const r = new InputRouter(backend);
  await r.dispatch({ t: 'pointer', id: 0, phase: 'down', x: 0.2, y: 0.2 });
  await r.dispatch({ t: 'pointer', id: 1, phase: 'down', x: 0.8, y: 0.8 });
  await r.dispatch({ t: 'pointer', id: 0, phase: 'move', x: 0.3, y: 0.3 });
  await r.dispatch({ t: 'pointer', id: 1, phase: 'move', x: 0.7, y: 0.7 });
  await r.dispatch({ t: 'pointer', id: 0, phase: 'up', x: 0.35, y: 0.35 });
  // not flushed until all fingers are up
  assert(!calls.some((c) => c.method === 'gesture'), 'should not flush until every finger lifts');
  await r.dispatch({ t: 'pointer', id: 1, phase: 'up', x: 0.65, y: 0.65 });
  assert(calls.length === 1 && calls[0].method === 'gesture', 'expected one multi-finger gesture');
  const paths = calls[0].args[0] as NormPath[];
  assert(paths.length === 2, `expected 2 paths, got ${paths.length}`);
});

inputStreaming.test('down+cancel injects nothing', async () => {
  const { backend, calls } = recordingBackend();
  const r = new InputRouter(backend);
  await r.dispatch({ t: 'pointer', phase: 'down', x: 0.5, y: 0.5 });
  await r.dispatch({ t: 'pointer', phase: 'cancel', x: 0.5, y: 0.5 });
  assert(calls.length === 0, `cancel should inject nothing, got ${JSON.stringify(calls)}`);
});

inputStreaming.test('onClose flushes a still-open drag', async () => {
  const { backend, calls } = recordingBackend();
  const r = new InputRouter(backend);
  await r.dispatch({ t: 'pointer', phase: 'down', x: 0.1, y: 0.1 });
  await r.dispatch({ t: 'pointer', phase: 'move', x: 0.6, y: 0.6 });
  assert(!calls.some((c) => c.method === 'gesture'), 'nothing flushed mid-drag');
  await r.onClose();
  assert(calls.length === 1 && calls[0].method === 'gesture', 'onClose should flush the open drag');
});

// ── Router: non-pointer frames ───────────────────────────────────────────────

inputStreaming.test('key/text/button/scroll/tvremote route to the backend', async () => {
  const { backend, calls } = recordingBackend();
  const r = new InputRouter(backend);
  await r.dispatch({ t: 'key', code: 'Enter', down: true });
  await r.dispatch({ t: 'text', value: 'hi' });
  await r.dispatch({ t: 'button', name: 'home', holdMs: 100 });
  await r.dispatch({ t: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: 0.2 });
  await r.dispatch({ t: 'tvremote', button: 'select' });
  assert(calls[0].method === 'key' && calls[0].args[0] === 'Enter', 'key route');
  assert(calls[1].method === 'text' && calls[1].args[0] === 'hi', 'text route');
  assert(calls[2].method === 'button' && calls[2].args[0] === 'home', 'button route');
  assert(calls[3].method === 'swipe', 'scroll → swipe');
  // scroll from (0.5,0.5) by dy 0.2 → end y 0.3
  assert((calls[3].args[3] as number) === 0.3, `scroll end y wrong: ${calls[3].args[3]}`);
  assert(calls[4].method === 'button' && calls[4].args[0] === 'select', 'tvremote → button');
});

// ── Backend: coordinate + keymap translation (iOS) ───────────────────────────

inputStreaming.test('iosBackend translates normalized → points and maps keys', async () => {
  const mock = new MockIOSDriver();
  const be = iosBackend(mock);
  await be.tap(0.5, 0.5);
  await be.swipe(0, 0, 1, 1, 500);
  await be.key('Backspace');
  await be.button('home');
  const tap = mock.calls.find((c) => c.method === 'tap')!;
  assert(tap.args[0] === 195 && tap.args[1] === 422, `tap points wrong: ${JSON.stringify(tap.args)}`);
  const swipe = mock.calls.find((c) => c.method === 'swipe')!;
  assert(swipe.args[2] === 390 && swipe.args[3] === 844, 'swipe end points wrong');
  assert(swipe.args[4] === 0.5, `swipe duration should be seconds (0.5), got ${swipe.args[4]}`);
  const key = mock.calls.find((c) => c.method === 'pressKey')!;
  assert(key.args[0] === 'delete', 'Backspace should map to delete');
  const btn = mock.calls.find((c) => c.method === 'pressButton')!;
  assert(btn.args[0] === 'home', 'home button');
});

inputStreaming.test('iosBackend advertises springboard + buffered liveDrag', async () => {
  const be = iosBackend(new MockIOSDriver());
  const caps = be.capabilities('buffered');
  assert(caps.springboard === true, 'iOS should advertise springboard');
  assert(caps.multitouch === true, 'iOS should advertise multitouch');
  assert(caps.liveDrag === 'buffered', 'liveDrag should reflect the arg');
});

// ── Server: handshake + coalescing over a real WebSocket ─────────────────────

inputStreaming.test('server sends hello and applies frames; moves coalesce', async () => {
  const { backend, calls } = recordingBackend();
  const handle = await startInputServer({
    port: 0,
    device: 'test-udid',
    platform: 'ios',
    makeRouter: () => new InputRouter(backend),
  });

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/input`);
    const hello = await new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.on('message', (d) => resolve(JSON.parse(d.toString())));
      ws.on('error', reject);
    });
    assert(hello.t === 'hello', 'first frame should be hello');
    assert((hello.platform as string) === 'ios', 'hello carries platform');
    assert(typeof hello.capabilities === 'object', 'hello carries capabilities');

    // A drag: many rapid moves between one down and one up.
    ws.send(JSON.stringify({ t: 'pointer', phase: 'down', x: 0.1, y: 0.1 }));
    for (let i = 0; i < 20; i++) {
      const p = 0.1 + (i / 20) * 0.8;
      ws.send(JSON.stringify({ t: 'pointer', phase: 'move', x: p, y: p }));
    }
    ws.send(JSON.stringify({ t: 'pointer', phase: 'up', x: 0.9, y: 0.9 }));

    // Wait for processing to settle.
    await new Promise((r) => setTimeout(r, 200));

    const gesture = calls.find((c) => c.method === 'gesture');
    assert(gesture !== undefined, 'drag should produce a gesture');
    const steps = (gesture!.args[0] as NormPath[])[0].steps;
    // Final position must be preserved even though intermediate moves coalesce.
    const last = steps[steps.length - 1];
    assert(Math.abs(last.nx - 0.9) < 1e-6, `final x should be 0.9, got ${last.nx}`);
    ws.close();
  } finally {
    await handle.close();
  }
});
