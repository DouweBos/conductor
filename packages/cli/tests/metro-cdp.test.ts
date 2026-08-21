/**
 * Unit tests for the Metro CDP client's target-selection logic.
 *
 * `selectDebuggerUrl` is the pure core of `resolveDebuggerUrl` — it picks a
 * `webSocketDebuggerUrl` from an already-fetched target list, so it can be
 * exercised without a live Metro server.
 */
import { TestSuite, assert } from './runner.js';
import { selectDebuggerUrl, resolveMetroPort } from '../src/drivers/metro-cdp.js';
import type { MetroTarget } from '../src/drivers/log-sources/metro.js';

export const metroCdp = new TestSuite('metro-cdp target selection');

function target(overrides: Partial<MetroTarget>): MetroTarget {
  return { webSocketDebuggerUrl: 'ws://localhost:8081/x', ...overrides };
}

metroCdp.test('throws when there are no targets', async () => {
  let threw = false;
  try {
    selectDebuggerUrl([], {});
  } catch (err) {
    threw = true;
    assert(
      err instanceof Error && /no debugger targets/.test(err.message),
      'error should mention missing targets'
    );
  }
  assert(threw, 'should throw on empty target list');
});

metroCdp.test('throws when no target has a websocket url', async () => {
  let threw = false;
  try {
    selectDebuggerUrl([{ title: 'no ws' }], {});
  } catch {
    threw = true;
  }
  assert(threw, 'should throw when targets lack webSocketDebuggerUrl');
});

metroCdp.test('targetIndex selects the matching target', async () => {
  const targets = [
    target({ webSocketDebuggerUrl: 'ws://a' }),
    target({ webSocketDebuggerUrl: 'ws://b' }),
    target({ webSocketDebuggerUrl: 'ws://c' }),
  ];
  assert(selectDebuggerUrl(targets, { targetIndex: 1 }) === 'ws://b', 'index 1 → b');
});

metroCdp.test('targetIndex out of range throws', async () => {
  const targets = [target({ webSocketDebuggerUrl: 'ws://a' })];
  let threw = false;
  try {
    selectDebuggerUrl(targets, { targetIndex: 5 });
  } catch (err) {
    threw = true;
    assert(err instanceof Error && /out of range/.test(err.message), 'mentions out of range');
  }
  assert(threw, 'should throw for index past the end');
});

metroCdp.test('negative targetIndex throws', async () => {
  const targets = [target({ webSocketDebuggerUrl: 'ws://a' })];
  let threw = false;
  try {
    selectDebuggerUrl(targets, { targetIndex: -1 });
  } catch {
    threw = true;
  }
  assert(threw, 'should throw for a negative index');
});

metroCdp.test('displayName picks the matching device target', async () => {
  const targets = [
    target({ webSocketDebuggerUrl: 'ws://other', deviceName: 'iPhone 14' }),
    target({ webSocketDebuggerUrl: 'ws://mine', deviceName: 'iPhone 15 Pro' }),
  ];
  assert(
    selectDebuggerUrl(targets, { deviceId: 'udid' }, 'iPhone 15 Pro') === 'ws://mine',
    'should select the target whose deviceName matches'
  );
});

metroCdp.test('tolerates Metro suffixing the model name', async () => {
  const targets = [
    target({ webSocketDebuggerUrl: 'ws://atv', deviceName: 'Menu - Apple TV 4K' }),
    target({ webSocketDebuggerUrl: 'ws://cast', deviceName: 'Chromecast - 14 - API 34' }),
  ];
  assert(
    selectDebuggerUrl(targets, { deviceId: '33021HFDD8EW8F' }, 'Chromecast') === 'ws://cast',
    'bare model "Chromecast" should match "Chromecast - 14 - API 34"'
  );
});

metroCdp.test('device requested but unmatched throws instead of picking another', async () => {
  const targets = [
    target({ webSocketDebuggerUrl: 'ws://plain', title: 'Page', deviceName: 'iPhone 14' }),
    target({ webSocketDebuggerUrl: 'ws://hermes', title: 'Hermes React Native' }),
  ];
  let threw = false;
  try {
    selectDebuggerUrl(targets, { deviceId: 'udid' }, 'No Such Device');
  } catch (err) {
    threw = true;
    assert(
      err instanceof Error && /No Metro debugger target for device udid/.test(err.message),
      'error should name the unmatched device'
    );
  }
  assert(threw, 'a device-scoped call with no match must not silently reload another device');
});

metroCdp.test('prefers a Hermes/React-titled target over the first', async () => {
  const targets = [
    target({ webSocketDebuggerUrl: 'ws://first', title: 'Other' }),
    target({ webSocketDebuggerUrl: 'ws://react', title: 'React Native Bridge' }),
  ];
  assert(selectDebuggerUrl(targets, {}) === 'ws://react', 'should prefer the React target');
});

metroCdp.test('falls back to the first target when nothing else matches', async () => {
  const targets = [
    target({ webSocketDebuggerUrl: 'ws://first', title: 'Alpha' }),
    target({ webSocketDebuggerUrl: 'ws://second', title: 'Beta' }),
  ];
  assert(selectDebuggerUrl(targets, {}) === 'ws://first', 'should fall back to the first target');
});

// ── Port resolution ───────────────────────────────────────────────────────────

// These guard the two branches that must never reach discovery, because both
// are what stop port auto-detection from changing behaviour for anyone who was
// relying on the old fixed default.

metroCdp.test('an explicit port wins and is never second-guessed', async () => {
  const port = await resolveMetroPort({ port: 8082, deviceId: 'emulator-5554', platform: 'android' });
  assert(port === 8082, `expected 8082, got ${port}`);
});

metroCdp.test('an explicit port is honoured even when it is the old default', async () => {
  const port = await resolveMetroPort({ port: 8081, deviceId: 'emulator-5554', platform: 'android' });
  assert(port === 8081, `expected 8081, got ${port}`);
});

metroCdp.test('falls back to 8081 with no device to ask', async () => {
  assert((await resolveMetroPort({})) === 8081, 'no device/platform');
  assert((await resolveMetroPort({ deviceId: 'x' })) === 8081, 'device without platform');
  assert((await resolveMetroPort({ platform: 'android' })) === 8081, 'platform without device');
});

metroCdp.test('falls back to 8081 when discovery finds nothing', async () => {
  // A device id that cannot resolve: discovery must fail soft, not throw.
  const port = await resolveMetroPort({ deviceId: 'no-such-device-9999', platform: 'android' });
  assert(port === 8081, `expected the 8081 fallback, got ${port}`);
});
