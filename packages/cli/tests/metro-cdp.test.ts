/**
 * Unit tests for the Metro CDP client's target-selection logic.
 *
 * `selectDebuggerUrl` is the pure core of `resolveDebuggerUrl` — it picks a
 * `webSocketDebuggerUrl` from an already-fetched target list, so it can be
 * exercised without a live Metro server.
 */
import { TestSuite, assert } from './runner.js';
import { selectDebuggerUrl } from '../src/drivers/metro-cdp.js';
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
    selectDebuggerUrl(targets, {}, 'iPhone 15 Pro') === 'ws://mine',
    'should select the target whose deviceName matches'
  );
});

metroCdp.test('unmatched displayName falls back to the Hermes/React target', async () => {
  const targets = [
    target({ webSocketDebuggerUrl: 'ws://plain', title: 'Page' }),
    target({ webSocketDebuggerUrl: 'ws://hermes', title: 'Hermes React Native' }),
  ];
  assert(
    selectDebuggerUrl(targets, {}, 'No Such Device') === 'ws://hermes',
    'no device match → prefer the Hermes target'
  );
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
