/**
 * Tests for the web daemon's Chromium launch arguments.
 */
import { chromiumLaunchArgs } from '../src/daemon/web-server.js';
import { TestSuite, assert } from './runner.js';

export const webServer = new TestSuite('web server');

webServer.test('chromium allows DevTools origins on loopback only', () => {
  const args = chromiumLaunchArgs(9333);
  assert(args.includes('--remote-debugging-port=9333'), `missing debugging port: ${args}`);
  const origins = args.filter((a) => a.startsWith('--remote-allow-origins='));
  assert(
    origins.length === 1 && origins[0] === '--remote-allow-origins=http://127.0.0.1:9333',
    `unexpected allow-origins: ${JSON.stringify(origins)}`
  );
  return Promise.resolve();
});
