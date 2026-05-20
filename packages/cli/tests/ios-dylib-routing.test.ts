/**
 * Tests for IOSDriver dylib routing.
 *
 * After the host-side sim-driver landed (see ios-sim-driver-routing.test.ts),
 * the dylib's role narrowed to exactly one route: `inputText`. The five
 * HID-class routes (touch, swipeV2, gesturePath, pressKey, pressButton) all
 * route through the sim-driver now and skip the dylib entirely — see
 * docs/plans/ios-dylib-driver.md "Phase 6".
 *
 * What we verify here:
 *  - `inputText` prefers the dylib port and falls back to XCUITest on
 *    connection error / 404 / 5xx (unchanged behavior).
 *  - When no dylib port is set, `inputText` goes straight to XCUITest.
 *  - HID-class routes do NOT touch the dylib, even when its port is set —
 *    they're covered by the sim-driver suite.
 *  - Non-interaction routes still go to XCUITest only.
 *
 * The transport is a pair of tiny loopback HTTP servers — no XCTest runner
 * or simulator is required.
 */
import http from 'http';
import { AddressInfo } from 'net';
import { IOSDriver } from '../src/drivers/ios.js';
import { TestSuite, assert } from './runner.js';

interface HitLog {
  port: number;
  path: string;
  method: string;
}

async function startServer(
  hits: HitLog[],
  handler?: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const port = (server.address() as AddressInfo).port;
    hits.push({ port, path: req.url ?? '', method: req.method ?? '' });
    req.on('data', () => {});
    req.on('end', () => {
      if (handler) {
        handler(req, res);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export const iosDylibRouting = new TestSuite('iOS dylib routing');

iosDylibRouting.test('inputText routes to dylib first when dylib port is set', async () => {
  const hits: HitLog[] = [];
  const xctest = await startServer(hits);
  const dylib = await startServer(hits);
  try {
    const driver = new IOSDriver(xctest.port, '127.0.0.1', undefined, 'ios', dylib.port);
    await driver.inputText('hello');
    assert(hits.length === 1, `expected 1 hit, got ${hits.length}`);
    assert(hits[0].port === dylib.port, `expected dylib port, got ${hits[0].port}`);
    assert(hits[0].path === '/inputText', `expected /inputText, got ${hits[0].path}`);
  } finally {
    await dylib.close();
    await xctest.close();
  }
});

iosDylibRouting.test('inputText falls back to xctest on dylib 404 (no dylib loaded for app)', async () => {
  const hits: HitLog[] = [];
  const xctest = await startServer(hits);
  const dylib = await startServer(hits, (_req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
  });
  try {
    const driver = new IOSDriver(xctest.port, '127.0.0.1', undefined, 'ios', dylib.port);
    await driver.inputText('hi');
    assert(hits.length === 2, `expected 2 hits (dylib then xctest), got ${hits.length}`);
    assert(hits[0].port === dylib.port, 'first hit should be dylib');
    assert(hits[1].port === xctest.port, 'second hit should be xctest fallback');
  } finally {
    await dylib.close();
    await xctest.close();
  }
});

iosDylibRouting.test('inputText falls back to xctest on dylib connection refused', async () => {
  const hits: HitLog[] = [];
  const xctest = await startServer(hits);
  const orphan = await startServer([]);
  const deadPort = orphan.port;
  await orphan.close();
  try {
    const driver = new IOSDriver(xctest.port, '127.0.0.1', undefined, 'ios', deadPort);
    await driver.inputText('x');
    assert(hits.length === 1, `expected 1 hit (xctest fallback), got ${hits.length}`);
    assert(hits[0].port === xctest.port, 'fallback should hit xctest');
  } finally {
    await xctest.close();
  }
});

iosDylibRouting.test('HID routes never touch dylib (sim-driver owns those now)', async () => {
  // Even with a dylib port set and no sim-driver port, the dylib must not
  // see HID traffic. The five HID routes go straight to xctest.
  const hits: HitLog[] = [];
  const xctest = await startServer(hits);
  const dylib = await startServer(hits);
  try {
    const driver = new IOSDriver(xctest.port, '127.0.0.1', undefined, 'ios', dylib.port);
    await driver.tap(1, 1);
    await driver.swipe(0, 0, 1, 1, 0.1);
    await driver.gesturePath([{ steps: [{ x: 0, y: 0, dt: 0 }] }]);
    await driver.pressKey('return');
    await driver.pressButton('home');
    assert(hits.length === 5, `expected 5 hits, got ${hits.length}`);
    for (const hit of hits) {
      assert(hit.port === xctest.port, `HID route ${hit.path} hit dylib; should be xctest`);
    }
  } finally {
    await dylib.close();
    await xctest.close();
  }
});

iosDylibRouting.test('non-interaction routes always go to xctest', async () => {
  const hits: HitLog[] = [];
  const xctest = await startServer(hits, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/deviceInfo') {
      res.end('{"widthPoints":100,"heightPoints":200,"widthPixels":300,"heightPixels":600}');
    } else {
      res.end('{"ok":true}');
    }
  });
  const dylib = await startServer(hits);
  try {
    const driver = new IOSDriver(xctest.port, '127.0.0.1', undefined, 'ios', dylib.port);
    await driver.deviceInfo();
    await driver.terminateApp('com.example');
    await driver.setOrientation('portrait');
    assert(hits.length === 3, `expected 3 hits, got ${hits.length}`);
    for (const hit of hits) {
      assert(
        hit.port === xctest.port,
        `expected ${hit.path} on xctest port ${xctest.port}, got ${hit.port}`
      );
    }
  } finally {
    await dylib.close();
    await xctest.close();
  }
});

iosDylibRouting.test('without dylib port, inputText goes to xctest', async () => {
  const hits: HitLog[] = [];
  const xctest = await startServer(hits);
  try {
    const driver = new IOSDriver(xctest.port, '127.0.0.1', undefined, 'ios');
    await driver.inputText('x');
    assert(hits.length === 1, `expected 1 hit, got ${hits.length}`);
    assert(hits[0].port === xctest.port, `expected xctest port, got ${hits[0].port}`);
  } finally {
    await xctest.close();
  }
});

iosDylibRouting.test('setDylibPort can enable / disable inputText routing at runtime', async () => {
  const hits: HitLog[] = [];
  const xctest = await startServer(hits);
  const dylib = await startServer(hits);
  try {
    const driver = new IOSDriver(xctest.port, '127.0.0.1', undefined, 'ios');
    await driver.inputText('a');
    assert(hits[hits.length - 1].port === xctest.port, 'initial inputText should hit xctest');

    driver.setDylibPort(dylib.port);
    await driver.inputText('b');
    assert(hits[hits.length - 1].port === dylib.port, 'after enable should hit dylib');

    driver.setDylibPort(undefined);
    await driver.inputText('c');
    assert(hits[hits.length - 1].port === xctest.port, 'after disable should hit xctest');
  } finally {
    await dylib.close();
    await xctest.close();
  }
});
