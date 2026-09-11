/**
 * Unit tests for `metro use` location parsing.
 *
 * `normalizeMetroLocation` is the pure part of the command — it turns whatever
 * the user typed into the `host:port` string written to `RCT_jsLocation`, so it
 * can be exercised without a simulator.
 */
import { TestSuite, assert } from './runner.js';
import { normalizeMetroLocation } from '../src/commands/metro.js';

export const metroUse = new TestSuite('metro use location parsing');

metroUse.test('a bare port defaults to localhost', async () => {
  assert(normalizeMetroLocation('8102') === 'localhost:8102', 'string port should get a host');
  // minimist hands a bare numeric argument over as a number.
  assert(normalizeMetroLocation(8102) === 'localhost:8102', 'numeric port should get a host');
});

metroUse.test('keeps an explicit host', async () => {
  assert(normalizeMetroLocation('127.0.0.1:8081') === '127.0.0.1:8081', 'ip host should survive');
  assert(normalizeMetroLocation('my-mac.local:8082') === 'my-mac.local:8082', 'dns host survives');
});

metroUse.test('tolerates a pasted URL', async () => {
  assert(normalizeMetroLocation('http://localhost:8102/') === 'localhost:8102', 'scheme stripped');
  assert(normalizeMetroLocation('  https://host:9000  ') === 'host:9000', 'trimmed and stripped');
});

metroUse.test('rejects out-of-range ports', async () => {
  for (const bad of ['0', '99999', 'host:70000']) {
    let threw = false;
    try {
      normalizeMetroLocation(bad);
    } catch (err) {
      threw = true;
      assert(err instanceof Error && /invalid port/.test(err.message), `${bad}: port message`);
    }
    assert(threw, `should reject "${bad}"`);
  }
});

metroUse.test('rejects anything that is not a location', async () => {
  for (const bad of ['', 'not a port', 'localhost', 'host:', ':8081', 'host:80:81']) {
    let threw = false;
    try {
      normalizeMetroLocation(bad);
    } catch (err) {
      threw = true;
      assert(
        err instanceof Error && /invalid location/.test(err.message),
        `${bad}: location message`
      );
    }
    assert(threw, `should reject "${bad}"`);
  }
});
