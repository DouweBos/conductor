/**
 * Unit tests for macOS support: shortcut and argument parsing, the fixed `macos`
 * device ID, the background driver's capture routes, and the guarantee that no
 * simulator-only path runs against the host Mac.
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { TestSuite, assert } from './runner.js';
import { detectPlatform } from '../src/drivers/bootstrap.js';
import {
  MacDriver,
  parseLsappinfoPid,
  parseMacKeyCombo,
  parseMacModifiers,
} from '../src/drivers/macos.js';
import { macCpuArgs } from '../src/commands/profile.js';
import { macViewportFlagError } from '../src/commands/set-viewport.js';
import { parseWindowArgs } from '../src/commands/window.js';

export const macos = new TestSuite('macOS');

async function rejects(p: Promise<unknown>, pattern: RegExp, label: string): Promise<void> {
  try {
    await p;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(pattern.test(msg), `${label}: unexpected error "${msg}"`);
    return;
  }
  throw new Error(`${label}: expected a rejection`);
}

macos.test('parses shortcuts into a key and modifiers', async () => {
  const cases: Array<[string, string, string[]]> = [
    ['cmd+s', 's', ['command']],
    ['Cmd+Shift+Z', 'z', ['command', 'shift']],
    ['ctrl+tab', 'tab', ['control']],
    ['⌘+,', ',', ['command']],
    ['cmd++', '+', ['command']],
    ['alt+Page Up', 'pageup', ['option']],
    ['Enter', 'enter', []],
    ['F5', 'f5', []],
  ];
  for (const [input, key, modifiers] of cases) {
    const parsed = parseMacKeyCombo(input);
    assert(parsed !== null, `${input} should parse`);
    assert(parsed.key === key, `${input}: key ${parsed.key}, want ${key}`);
    assert(
      parsed.modifiers.join(',') === modifiers.join(','),
      `${input}: modifiers ${parsed.modifiers.join(',')}, want ${modifiers.join(',')}`
    );
  }
});

macos.test('rejects unknown modifiers and keys', async () => {
  for (const input of ['hyper+s', 'cmd+', 'cmd+notakey', 'Remote Dpad Up', '']) {
    assert(parseMacKeyCombo(input) === null, `${JSON.stringify(input)} should not parse`);
  }
});

macos.test('parses --modifiers lists', async () => {
  assert(parseMacModifiers('cmd,shift')?.join(',') === 'command,shift', 'cmd,shift');
  assert(parseMacModifiers('opt+ctrl')?.join(',') === 'option,control', 'opt+ctrl');
  assert(parseMacModifiers('')?.length === 0, 'empty list');
  assert(parseMacModifiers('cmd,bogus') === null, 'unknown name');
});

macos.test('"macos" is the host Mac', async () => {
  assert((await detectPlatform('macos')) === 'macos', 'detectPlatform("macos")');
});

macos.test('simulator-only operations fail cleanly instead of running simctl', async () => {
  const driver = new MacDriver(1);
  await rejects(driver.setLocation(1, 2), /set-location is not supported on macOS/, 'setLocation');
  await rejects(driver.addMedia('/tmp/x.png'), /not supported on macOS/, 'addMedia');
  await rejects(driver.clearAppState('com.example'), /not supported on macOS/, 'clearAppState');
  await rejects(driver.uninstallApp('com.example'), /not supported on macOS/, 'uninstallApp');
  await rejects(driver.clearKeychain(), /not supported on macOS/, 'clearKeychain');
  await rejects(
    driver.launchApp('com.example', undefined, { dylibPath: '/x', inprocPort: 1 }),
    /injection is not supported on macOS/,
    'launchApp --inject'
  );
});

/** A stand-in driver answering each route with a fixed status and body. */
async function fakeDriver(
  routes: Record<string, [number, unknown]>
): Promise<{ port: number; seen: Array<{ path: string; body: unknown }>; close(): void }> {
  const seen: Array<{ path: string; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const path = (req.url ?? '').replace(/^\//, '');
      seen.push({ path, body: raw ? JSON.parse(raw) : undefined });
      const [status, body] = routes[path] ?? [404, { error: 'not found' }];
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, seen, close: () => server.close() };
}

macos.test('recording and streaming go through the background driver routes', async () => {
  const fake = await fakeDriver({
    'recording/start': [200, {}],
    'recording/stop': [200, { path: '/tmp/out.mp4' }],
    'stream/start': [200, { port: 4242 }],
  });
  try {
    const driver = new MacDriver(fake.port);
    await driver.startRecording('/tmp/out.mp4');
    assert(
      (fake.seen[0].body as { path: string }).path === '/tmp/out.mp4',
      'recording/start carries the absolute path'
    );
    assert((await driver.finishRecording()) === '/tmp/out.mp4', 'recording/stop returns the file');
    assert((await driver.startStream()) === 4242, 'stream/start returns the TCP port');
  } finally {
    fake.close();
  }
});

macos.test('capture routes explain the foreground driver lacks them', async () => {
  const fake = await fakeDriver({
    'recording/stop': [400, { errorMessage: 'no recording is running' }],
  });
  try {
    const driver = new MacDriver(fake.port);
    await rejects(driver.startStream(), /needs the background macOS driver/, 'foreground 404');
    await rejects(driver.finishRecording(), /no recording is running/, 'driver error message');
  } finally {
    fake.close();
  }
});

macos.test('set-viewport rejects web-only flags on macOS', async () => {
  assert(macViewportFlagError({ width: 800, height: 600 }) === null, 'plain size is fine');
  assert(macViewportFlagError({ preset: 'desktop' }) === null, 'a preset only sets the size');
  const one = macViewportFlagError({ width: 800, height: 600, scale: 2 });
  assert(one !== null && /--scale is web-only/.test(one), `single flag: ${one}`);
  const many = macViewportFlagError({ mobile: true, userAgent: 'x', colorScheme: 'dark' });
  assert(
    many !== null && /--mobile, --user-agent, --color-scheme are web-only/.test(many),
    `several flags: ${many}`
  );
});

macos.test('parses window arguments', async () => {
  const eq = (a: unknown, b: unknown, label: string) =>
    assert(JSON.stringify(a) === JSON.stringify(b), `${label}: ${JSON.stringify(a)}`);
  eq(parseWindowArgs(['list']), { sub: 'list' }, 'list');
  eq(parseWindowArgs(['focus', 'Untitled', '2']), { sub: 'focus', title: 'Untitled 2' }, 'focus');
  eq(parseWindowArgs(['focus'], true), { sub: 'focus', title: '' }, 'focus --clear');
  assert(typeof parseWindowArgs(['focus']) === 'string', 'focus without a title');
  assert(typeof parseWindowArgs([]) === 'string', 'no subcommand');
  assert(typeof parseWindowArgs(['close']) === 'string', 'unknown subcommand');
});

macos.test('finds an app pid in lsappinfo output', async () => {
  assert(parseLsappinfoPid('"pid"=1234\n') === 1234, 'plain');
  assert(parseLsappinfoPid('"pid" = 98') === 98, 'spaced');
  assert(parseLsappinfoPid('') === undefined, 'not running prints nothing');
  assert(parseLsappinfoPid('"pid"=[ NULL ]') === undefined, 'no number');
});

macos.test('profile cpu attaches xctrace by pid with no --device', async () => {
  const args = macCpuArgs(4321, 5, '/tmp/cpu.trace');
  assert(!args.includes('--device'), 'no --device on the host');
  assert(args[args.indexOf('--attach') + 1] === '4321', 'attaches by pid');
  assert(args[args.indexOf('--time-limit') + 1] === '5s', 'time limit');
  assert(args[args.indexOf('--output') + 1] === '/tmp/cpu.trace', 'output');
});
