/**
 * Tests for the streaming device-video system: the Annex B parser (SPS/PPS →
 * config extraction, access-unit splitting, keyframe flagging), the fan-out hub
 * (late-joiner config + keyframe caching), and the WebSocket server handshake
 * (JSON config frame then binary access units, capture lifecycle ref-counting).
 *
 * All device-free — the server talks to a fake capture source driven from the
 * test, and the parser is fed a hand-built elementary stream.
 */
import { WebSocket } from 'ws';
import { TestSuite, assert } from './runner.js';
import { H264AnnexBParser } from '../src/daemon/h264-annexb.js';
import { VideoHub } from '../src/daemon/video-hub.js';
import { startVideoServer } from '../src/daemon/video-server.js';
import type { VideoSource } from '../src/daemon/video-source.js';
import type { VideoConfig } from '../src/daemon/video-protocol.js';

// ── Synthetic H.264 Annex B stream ──────────────────────────────────────────

const SC = [0x00, 0x00, 0x00, 0x01];
// Baseline SPS hand-encoded for 176x144 (avc1.42001e); see the test that asserts dims.
const SPS = [0x67, 0x42, 0x00, 0x1e, 0xf8, 0x58, 0x9c, 0x80];
const PPS = [0x68, 0xce, 0x38, 0x80];
const IDR = [0x65, 0x88, 0x84, 0x21, 0x00]; // type 5 (keyframe)
const SLICE = [0x41, 0x9a, 0x00]; // type 1 (non-keyframe)
const AUD = [0x09, 0x10]; // access unit delimiter — used only to flush the prior NAL

function annexB(...nals: number[][]): Buffer {
  const parts: number[] = [];
  for (const nal of nals) parts.push(...SC, ...nal);
  return Buffer.from(parts);
}

export const videoStreaming = new TestSuite('video streaming');

// ── Parser ───────────────────────────────────────────────────────────────────

videoStreaming.test('parser extracts config from SPS/PPS with correct dims + codec', async () => {
  let config: VideoConfig | null = null;
  const parser = new H264AnnexBParser({
    onConfig: (c) => {
      config = c;
    },
    onFrame: () => {},
  });
  // IDR's start code delimits PPS; AUD's start code delimits IDR.
  parser.push(annexB(SPS, PPS, IDR, AUD));
  assert(config !== null, 'expected a config');
  const c = config as unknown as VideoConfig;
  assert(c.codec === 'h264', 'codec should be h264');
  assert(c.width === 176 && c.height === 144, `dims wrong: ${c.width}x${c.height}`);
  assert(c.codecString === 'avc1.42001e', `codec string wrong: ${c.codecString}`);
  assert(!!c.sps && !!c.pps && !!c.avcC, 'sps/pps/avcC should be present');
});

videoStreaming.test('parser emits keyframe-flagged Annex B access units', async () => {
  const frames: Array<{ key: boolean; data: Buffer }> = [];
  const parser = new H264AnnexBParser({
    onConfig: () => {},
    onFrame: (data, key) => frames.push({ key, data }),
  });
  // SPS,PPS,IDR then SLICE then AUD: IDR flushes on SLICE's SC, SLICE on AUD's SC.
  parser.push(annexB(SPS, PPS, IDR, SLICE, AUD));
  assert(frames.length === 2, `expected 2 access units, got ${frames.length}`);
  assert(frames[0].key === true, 'first AU (IDR) should be a keyframe');
  assert(frames[1].key === false, 'second AU (slice) should not be a keyframe');
  // Access units are preserved in Annex B form (start code intact).
  assert(
    frames[0].data.subarray(0, 4).equals(Buffer.from(SC)),
    'AU should retain its Annex B start code'
  );
});

videoStreaming.test('parser drops frames until config is available', async () => {
  const frames: unknown[] = [];
  const parser = new H264AnnexBParser({
    onConfig: () => {},
    onFrame: (d) => frames.push(d),
  });
  // IDR with no SPS/PPS ahead of it → undecodable, must be dropped.
  parser.push(annexB(IDR, AUD));
  assert(frames.length === 0, 'frames before config should be dropped');
});

// ── Hub ───────────────────────────────────────────────────────────────────────

videoStreaming.test('hub replays cached config + keyframe to a late subscriber', async () => {
  const hub = new VideoHub();
  const cfg: VideoConfig = { codec: 'h264', width: 176, height: 144, rotation: 0, fps: 30 };
  hub.emitConfig(cfg);
  hub.emitFrame(Buffer.from([1, 2, 3]), true); // keyframe
  hub.emitFrame(Buffer.from([4, 5, 6]), false); // delta — must NOT be replayed

  const got: Array<string> = [];
  hub.subscribe({
    onConfig: () => got.push('config'),
    onFrame: (_d, key) => got.push(key ? 'key' : 'delta'),
  });
  assert(
    got.join(',') === 'config,key',
    `late subscriber should get config + keyframe only, got: ${got.join(',')}`
  );
});

videoStreaming.test('hub tracks subscriber count and clears cache', async () => {
  const hub = new VideoHub();
  const unsub = hub.subscribe({ onConfig: () => {}, onFrame: () => {} });
  const beforeUnsub = hub.subscriberCount;
  assert(beforeUnsub === 1, 'count should be 1');
  hub.emitConfig({ codec: 'h264', width: 2, height: 2, rotation: 0, fps: 30 });
  assert(hub.dims()?.width === 2, 'dims should reflect config');
  unsub();
  const afterUnsub = hub.subscriberCount;
  assert(afterUnsub === 0, 'count should be 0 after unsub');
  hub.clear();
  assert(hub.dims() === null, 'dims should be null after clear');
});

// ── Server: handshake + capture lifecycle over a real WebSocket ──────────────

/** Fake capture source: records start/stop and pushes a config+keyframe on start. */
function fakeSource(hub: VideoHub): { source: VideoSource; starts: () => number; stops: () => number } {
  const counts = { started: 0, stopped: 0 };
  const source: VideoSource = {
    async start() {
      counts.started++;
      hub.emitConfig({
        codec: 'h264',
        width: 176,
        height: 144,
        rotation: 0,
        fps: 30,
        codecString: 'avc1.42001e',
        sps: Buffer.from(SPS),
        pps: Buffer.from(PPS),
      });
      hub.emitFrame(Buffer.from([0xaa, 0xbb]), true);
    },
    async stop() {
      counts.stopped++;
    },
  };
  return { source, starts: () => counts.started, stops: () => counts.stopped };
}

videoStreaming.test('server sends config frame then binary AU; capture starts on first sub', async () => {
  // The source must bind to the hub the server owns (passed into makeSource),
  // not a test-local one, or its frames never reach subscribers.
  let fake: ReturnType<typeof fakeSource> | null = null;
  const handle = await startVideoServer({
    port: 0,
    device: 'test-udid',
    platform: 'ios',
    makeSource: (hub) => {
      fake = fakeSource(hub);
      return fake.source;
    },
  });

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/stream?device=test-udid&platform=ios`);
    const messages: Array<{ binary: boolean; data: Buffer | string }> = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('message', (data, isBinary) => {
        messages.push({ binary: isBinary, data: isBinary ? (data as Buffer) : data.toString() });
        if (messages.length >= 2) resolve();
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timed out waiting for frames')), 3000);
    });

    assert(!messages[0].binary, 'first message should be the JSON config frame');
    const cfg = JSON.parse(messages[0].data as string);
    assert(cfg.t === 'config', 'first frame is a config');
    assert(cfg.codec === 'h264' && cfg.width === 176, 'config carries codec + dims');
    assert(typeof cfg.sps === 'string', 'config carries base64 sps');
    assert(cfg.platform === 'ios', 'config carries platform');

    assert(messages[1].binary, 'second message should be a binary access unit');
    assert((messages[1].data as Buffer).equals(Buffer.from([0xaa, 0xbb])), 'AU bytes forwarded');

    assert(fake!.starts() === 1, 'capture should start once on first subscriber');

    // Last subscriber leaving stops capture.
    await new Promise<void>((resolve) => {
      ws.on('close', () => resolve());
      ws.close();
    });
    await new Promise((r) => setTimeout(r, 200));
    assert(fake!.stops() >= 1, 'capture should stop when the last subscriber leaves');
  } finally {
    await handle.close();
  }
});
