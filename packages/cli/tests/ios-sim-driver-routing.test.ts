/**
 * Tests for IOSDriver host-side sim-driver routing.
 *
 * Verifies the architecture pivot from "dylib does everything experimental"
 * to "dylib does in-process bits, sim-driver does HID":
 *  - The five HID-class routes (touch, swipeV2, gesturePath, pressKey,
 *    pressButton) prefer the sim-driver port and only hit the XCUITest port
 *    when the sim-driver is missing or returns a non-2xx response.
 *  - The HID routes do NOT chain through the dylib — the dylib is dropped
 *    from HID routing entirely.
 *  - `inputText` continues to prefer the dylib (unchanged behavior).
 *  - All non-interaction routes (viewHierarchy, screenshot, deviceInfo, …)
 *    always go to the XCUITest port regardless of whether sim-driver /
 *    dylib ports are configured.
 *  - When no sim-driver port is configured, HID routes go straight to
 *    XCUITest (compatibility with the previous single-driver mode).
 *
 * Transport: three loopback HTTP servers (sim, dylib, xctest). No simulator
 * or real binary required.
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

export const iosSimDriverRouting = new TestSuite('iOS sim-driver routing');

iosSimDriverRouting.test('tap routes to sim-driver first when sim-driver port is set', async () => {
  const hits: HitLog[] = [];
  const xctest = await startServer(hits);
  const sim = await startServer(hits);
  try {
    const driver = new IOSDriver(xctest.port, '127.0.0.1', undefined, 'ios', undefined, sim.port);
    await driver.tap(10, 20);
    assert(hits.length === 1, `expected 1 hit, got ${hits.length}`);
    assert(hits[0].port === sim.port, `expected sim port ${sim.port}, got ${hits[0].port}`);
    assert(hits[0].path === '/touch', `expected /touch, got ${hits[0].path}`);
  } finally {
    await sim.close();
    await xctest.close();
  }
});

iosSimDriverRouting.test('tap falls back to xctest on sim-driver 500', async () => {
  const hits: HitLog[] = [];
  const xctest = await startServer(hits);
  const sim = await startServer(hits, (_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":"not ready"}');
  });
  try {
    const driver = new IOSDriver(xctest.port, '127.0.0.1', undefined, 'ios', undefined, sim.port);
    await driver.tap(10, 20);
    assert(hits.length === 2, `expected 2 hits (sim then xctest), got ${hits.length}`);
    assert(hits[0].port === sim.port, 'first hit should be sim');
    assert(hits[1].port === xctest.port, 'second hit should be xctest fallback');
  } finally {
    await sim.close();
    await xctest.close();
  }
});

iosSimDriverRouting.test('tap falls back to xctest on sim-driver 404', async () => {
  const hits: HitLog[] = [];
  const xctest = await startServer(hits);
  const sim = await startServer(hits, (_req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
  });
  try {
    const driver = new IOSDriver(xctest.port, '127.0.0.1', undefined, 'ios', undefined, sim.port);
    await driver.tap(10, 20);
    assert(hits.length === 2, `expected 2 hits, got ${hits.length}`);
    assert(hits[1].port === xctest.port, 'should fall back to xctest');
  } finally {
    await sim.close();
    await xctest.close();
  }
});

iosSimDriverRouting.test('tap falls back to xctest on sim-driver connection refused', async () => {
  const hits: HitLog[] = [];
  const xctest = await startServer(hits);
  const orphan = await startServer([]);
  const deadPort = orphan.port;
  await orphan.close();
  try {
    const driver = new IOSDriver(xctest.port, '127.0.0.1', undefined, 'ios', undefined, deadPort);
    await driver.tap(10, 20);
    assert(hits.length === 1, `expected 1 hit, got ${hits.length}`);
    assert(hits[0].port === xctest.port, 'fallback should hit xctest');
  } finally {
    await xctest.close();
  }
});

iosSimDriverRouting.test('all five HID routes prefer sim-driver when set', async () => {
  const hits: HitLog[] = [];
  const xctest = await startServer(hits);
  const sim = await startServer(hits);
  try {
    const driver = new IOSDriver(xctest.port, '127.0.0.1', undefined, 'ios', undefined, sim.port);
    await driver.tap(1, 1);
    await driver.swipe(0, 0, 10, 10, 0.3);
    await driver.gesturePath([{ steps: [{ x: 0, y: 0, dt: 0 }, { x: 5, y: 5, dt: 0.1 }] }]);
    await driver.pressKey('return');
    await driver.pressButton('home');
    assert(hits.length === 5, `expected 5 hits, got ${hits.length}`);
    for (const hit of hits) {
      assert(
        hit.port === sim.port,
        `expected all hits on sim port, got ${hit.port} for ${hit.path}`
      );
    }
    const paths = hits.map((h) => h.path).sort();
    assert(
      JSON.stringify(paths) ===
        JSON.stringify(['/gesturePath', '/pressButton', '/pressKey', '/swipeV2', '/touch']),
      `unexpected paths: ${paths.join(',')}`
    );
  } finally {
    await sim.close();
    await xctest.close();
  }
});

iosSimDriverRouting.test('inputText still prefers dylib (HID drops dylib but inputText keeps it)', async () => {
  const hits: HitLog[] = [];
  const xctest = await startServer(hits);
  const dylib = await startServer(hits);
  const sim = await startServer(hits);
  try {
    const driver = new IOSDriver(
      xctest.port,
      '127.0.0.1',
      undefined,
      'ios',
      dylib.port,
      sim.port
    );
    await driver.inputText('hello');
    assert(hits.length === 1, `expected 1 hit, got ${hits.length}`);
    assert(hits[0].port === dylib.port, `inputText should hit dylib, got ${hits[0].port}`);
    assert(hits[0].path === '/inputText', `expected /inputText, got ${hits[0].path}`);
  } finally {
    await sim.close();
    await dylib.close();
    await xctest.close();
  }
});

iosSimDriverRouting.test('HID routes drop dylib entirely — go to sim, never dylib, even when both set', async () => {
  const hits: HitLog[] = [];
  const xctest = await startServer(hits);
  const dylib = await startServer(hits);
  const sim = await startServer(hits);
  try {
    const driver = new IOSDriver(
      xctest.port,
      '127.0.0.1',
      undefined,
      'ios',
      dylib.port,
      sim.port
    );
    await driver.tap(1, 1);
    await driver.pressKey('space');
    await driver.pressButton('home');
    assert(hits.length === 3, `expected 3 hits, got ${hits.length}`);
    for (const hit of hits) {
      assert(
        hit.port === sim.port,
        `HID route ${hit.path} should hit sim (${sim.port}), got ${hit.port}`
      );
    }
  } finally {
    await sim.close();
    await dylib.close();
    await xctest.close();
  }
});

iosSimDriverRouting.test('non-interaction routes always go to xctest', async () => {
  const hits: HitLog[] = [];
  const xctest = await startServer(hits, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/deviceInfo') {
      res.end('{"widthPoints":100,"heightPoints":200,"widthPixels":300,"heightPixels":600}');
    } else {
      res.end('{"ok":true}');
    }
  });
  const sim = await startServer(hits);
  try {
    const driver = new IOSDriver(xctest.port, '127.0.0.1', undefined, 'ios', undefined, sim.port);
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
    await sim.close();
    await xctest.close();
  }
});

iosSimDriverRouting.test('without sim-driver port, HID routes go straight to xctest', async () => {
  const hits: HitLog[] = [];
  const xctest = await startServer(hits);
  try {
    const driver = new IOSDriver(xctest.port, '127.0.0.1', undefined, 'ios');
    await driver.tap(1, 1);
    await driver.swipe(0, 0, 1, 1, 0.1);
    await driver.pressKey('return');
    await driver.pressButton('home');
    assert(hits.length === 4, `expected 4 hits, got ${hits.length}`);
    for (const hit of hits) {
      assert(hit.port === xctest.port, `expected xctest port, got ${hit.port}`);
    }
  } finally {
    await xctest.close();
  }
});

iosSimDriverRouting.test('setSimDriverPort can enable / disable routing at runtime', async () => {
  const hits: HitLog[] = [];
  const xctest = await startServer(hits);
  const sim = await startServer(hits);
  try {
    const driver = new IOSDriver(xctest.port, '127.0.0.1', undefined, 'ios');
    await driver.tap(1, 1);
    assert(hits[hits.length - 1].port === xctest.port, 'initial tap should hit xctest');

    driver.setSimDriverPort(sim.port);
    await driver.tap(1, 1);
    assert(hits[hits.length - 1].port === sim.port, 'after enable should hit sim');

    driver.setSimDriverPort(undefined);
    await driver.tap(1, 1);
    assert(hits[hits.length - 1].port === xctest.port, 'after disable should hit xctest');
  } finally {
    await sim.close();
    await xctest.close();
  }
});
