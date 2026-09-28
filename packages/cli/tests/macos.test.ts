/**
 * Unit tests for macOS support: shortcut parsing, the fixed `macos` device ID,
 * and the guarantee that no simulator-only path runs against the host Mac.
 */
import { TestSuite, assert } from './runner.js';
import { detectPlatform } from '../src/drivers/bootstrap.js';
import { MacDriver, parseMacKeyCombo, parseMacModifiers } from '../src/drivers/macos.js';

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
  await rejects(driver.startRecording('/tmp/x.mov'), /not supported on macOS/, 'startRecording');
  await rejects(
    driver.launchApp('com.example', undefined, { dylibPath: '/x', inprocPort: 1 }),
    /injection is not supported on macOS/,
    'launchApp --inject'
  );
});
