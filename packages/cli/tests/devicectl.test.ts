/**
 * Unit tests for the devicectl helpers backing physical iOS/tvOS support.
 * Covers the two things that decide whether a real device is usable: whether we
 * classify it as reachable, and what hostname we try to reach it on. Fixtures
 * are trimmed from real `xcrun devicectl list devices --json-output`.
 */
import { TestSuite, assert } from './runner.js';
import {
  parseDevicectlDevices,
  bonjourHostname,
  type DevicectlDevice,
} from '../src/drivers/devicectl.js';

export const devicectlSuite = new TestSuite('devicectl helpers');

function device(overrides: Partial<DevicectlDevice> = {}): DevicectlDevice {
  return {
    identifier: '3B8FD79A-D581-5582-8C5A-39FFE9B2144D',
    deviceProperties: {
      name: 'Livingroom TV',
      osVersionNumber: '26.6',
      developerModeStatus: 'enabled',
    },
    hardwareProperties: {
      platform: 'tvOS',
      udid: 'ee94fc86004c8a4d4dc0ebee118da183bb5c9515',
      marketingName: 'Apple TV 4K (2nd generation)',
      reality: 'physical',
    },
    connectionProperties: {
      pairingState: 'paired',
      tunnelState: 'disconnected',
      transportType: 'localNetwork',
      potentialHostnames: ['Livingroom-TV.coredevice.local'],
    },
    ...overrides,
  };
}

devicectlSuite.test('maps a reachable Apple TV', async () => {
  const [d] = parseDevicectlDevices({ result: { devices: [device()] } });
  assert(d.platform === 'tvos', `platform: ${d.platform}`);
  assert(d.available, 'a paired device with a transport is available');
  assert(d.udid === 'ee94fc86004c8a4d4dc0ebee118da183bb5c9515', 'udid');
  assert(d.developerModeEnabled, 'developer mode');
});

devicectlSuite.test('paired but unreachable devices are not available', async () => {
  // A device that's powered off or on another network keeps its pairing but
  // reports no transport — listing it as connected would send us into a
  // driver build that can never succeed.
  const [d] = parseDevicectlDevices({
    result: {
      devices: [
        device({
          connectionProperties: { pairingState: 'paired', tunnelState: 'unavailable' },
        }),
      ],
    },
  });
  assert(!d.available, 'no transport means not available');
});

devicectlSuite.test('skips simulators and unknown platforms', async () => {
  const parsed = parseDevicectlDevices({
    result: {
      devices: [
        device({ hardwareProperties: { platform: 'tvOS', reality: 'simulator' } }),
        device({ hardwareProperties: { platform: 'watchOS', reality: 'physical' } }),
        device({ hardwareProperties: { platform: 'xrOS', reality: 'physical' } }),
      ],
    },
  });
  assert(parsed.length === 0, `expected none, got ${parsed.length}`);
});

devicectlSuite.test('iPadOS is reported as ios', async () => {
  const [d] = parseDevicectlDevices({
    result: {
      devices: [device({ hardwareProperties: { platform: 'iPadOS', reality: 'physical' } })],
    },
  });
  assert(d.platform === 'ios', `platform: ${d.platform}`);
});

devicectlSuite.test('falls back to the identifier when udid/name are absent', async () => {
  const [d] = parseDevicectlDevices({
    result: {
      devices: [device({ deviceProperties: {}, hardwareProperties: { platform: 'iOS', reality: 'physical' } })],
    },
  });
  assert(d.udid === d.identifier, 'udid falls back to identifier');
  assert(d.name === d.identifier, 'name falls back to identifier');
});

devicectlSuite.test('tolerates empty and malformed payloads', async () => {
  assert(parseDevicectlDevices({}).length === 0, 'empty object');
  assert(parseDevicectlDevices({ result: {} }).length === 0, 'no devices key');
  assert(parseDevicectlDevices({ result: { devices: [] } }).length === 0, 'empty list');
});

devicectlSuite.test('derives the Bonjour hostname the way the device advertises it', async () => {
  assert(bonjourHostname('Livingroom TV') === 'Livingroom-TV.local', 'spaces become dashes');
  assert(bonjourHostname("Douwe's iPhone") === 'Douwe-s-iPhone.local', 'punctuation collapses');
  assert(bonjourHostname('Apple  TV   4K') === 'Apple-TV-4K.local', 'runs collapse to one dash');
  assert(bonjourHostname('(Test)') === 'Test.local', 'no leading/trailing dash');
});
