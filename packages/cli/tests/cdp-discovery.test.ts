/**
 * Unit tests for CDP discovery's pure helpers — device-id encode/parse and the
 * target→device mapping. The port scan itself needs a live endpoint, so it's not
 * covered here; these guard the id round-trip that makes a discovered webview
 * drivable with no --cdp-* flags.
 */
import { TestSuite, assert } from './runner.js';
import {
  formatCdpDeviceId,
  parseCdpDeviceId,
  cdpTargetsToDevices,
  type CdpTarget,
} from '../src/drivers/cdp-discovery.js';

export const cdpDiscovery = new TestSuite('cdp-discovery helpers');

cdpDiscovery.test('device id round-trips through format/parse', async () => {
  const id = formatCdpDeviceId(9222, 'ABCD1234');
  assert(id === 'web:cdp:9222:ABCD1234', `unexpected id: ${id}`);
  const parsed = parseCdpDeviceId(id);
  assert(parsed !== undefined, 'should parse its own id');
  assert(parsed!.port === 9222, 'port');
  assert(parsed!.targetId === 'ABCD1234', 'targetId');
  assert(parsed!.cdpUrl === 'http://127.0.0.1:9222', 'cdpUrl');
});

cdpDiscovery.test('parse tolerates target ids containing colons', async () => {
  const parsed = parseCdpDeviceId('web:cdp:9333:A:B:C');
  assert(parsed !== undefined, 'should parse');
  assert(parsed!.port === 9333, 'port');
  assert(parsed!.targetId === 'A:B:C', 'targetId keeps trailing colons');
});

cdpDiscovery.test('parse rejects non-cdp and malformed ids', async () => {
  assert(parseCdpDeviceId('web:chromium:abc1') === undefined, 'playwright id is not a cdp id');
  assert(parseCdpDeviceId('web') === undefined, 'bare web');
  assert(parseCdpDeviceId('web:cdp:notaport:x') === undefined, 'non-numeric port');
});

cdpDiscovery.test('only page targets become devices', async () => {
  const targets: CdpTarget[] = [
    { id: 't1', type: 'page', title: 'Tile 1', url: 'https://a' },
    { id: 't2', type: 'page', title: '', url: 'https://b' },
    { id: 't3', type: 'service_worker', title: 'sw', url: 'https://c' },
  ];
  const devices = cdpTargetsToDevices(9222, targets);
  assert(devices.length === 2, `expected 2 page devices, got ${devices.length}`);
  assert(devices[0].id === 'web:cdp:9222:t1', 'id encodes port+target');
  assert(devices[0].name === 'Tile 1', 'name from title');
  assert(devices[1].name === 'https://b', 'falls back to url when title empty');
  assert(devices.every((d) => d.platform === 'web' && d.status === 'running'), 'web/running');
});
