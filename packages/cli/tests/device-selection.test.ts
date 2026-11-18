/**
 * Device resolution must never route a web/CDP command to another platform's
 * device (e.g. the first booted Android emulator).
 */
import minimist from 'minimist';
import { resolveSessionName, DeviceSelectionError } from '../src/device-selection.js';
import { TestSuite, assert } from './runner.js';

export const deviceSelection = new TestSuite('device selection');

const OPTS = { string: ['device', 'device-name', 'cdp-url', 'cdp-target', 'platform'] };

/** Resolve exactly as index.ts does: minimist-parsed argv plus the raw args. */
const resolve = (args: string[], deps: Parameters<typeof resolveSessionName>[2]) =>
  resolveSessionName(minimist(args, OPTS), args, deps);

const WEB_FLAGS =
  '--device web:chromium:webtv --cdp-url http://127.0.0.1:9222 --cdp-target 8F0B307B499B5A98A3AEE8D6B85E9226';

/** Picker that "auto-picks" the lone Android emulator, like a box with one booted. */
const androidOnly = {
  pick: async () => 'emulator-5554',
  discover: async () => [{ id: 'emulator-5554', name: 'Pixel' }],
};

async function expectError(p: Promise<unknown>, match: RegExp): Promise<void> {
  try {
    const got = await p;
    throw new Error(`expected DeviceSelectionError, resolved to ${JSON.stringify(got)}`);
  } catch (err) {
    assert(err instanceof DeviceSelectionError, `wrong error: ${(err as Error).message}`);
    assert(
      match.test((err as Error).message),
      `message did not match ${match}: ${(err as Error).message}`
    );
  }
}

deviceSelection.test('explicit web:chromium device with CDP flags resolves to itself', async () => {
  const args = ['open-link', 'plex://movie/the-matrix', ...WEB_FLAGS.split(' ')];
  const name = await resolve(args, androidOnly);
  assert(name === 'web:chromium:webtv', `got ${name}`);
});

deviceSelection.test(
  'flags joined into one argument (zsh "$W") fail instead of picking Android',
  async () => {
    // zsh passes an unquoted $W as a single argv entry.
    const args = ['open-link', 'plex://movie/the-matrix', WEB_FLAGS];
    await expectError(resolve(args, androidOnly), /one argument/);
  }
);

deviceSelection.test('joined flags placed before the command are rejected too', async () => {
  const args = [WEB_FLAGS, 'inspect'];
  await expectError(resolve(args, androidOnly), /one argument/);
});

deviceSelection.test('--device=<value> swallowing further flags is rejected', async () => {
  const args = ['inspect', '--device=web:chromium:t1 --cdp-target ABC'];
  await expectError(resolve(args, androidOnly), /one argument/);
});

deviceSelection.test('CDP flags without --device do not fall back to a native device', async () => {
  const args = ['inspect', '--cdp-url', 'http://127.0.0.1:9222', '--cdp-target', 'ABC'];
  await expectError(resolve(args, androidOnly), /only work with web devices/);
});

deviceSelection.test('CDP flags with a non-web --device are rejected', async () => {
  const args = ['inspect', '--device', 'emulator-5554', '--cdp-target', 'ABC'];
  await expectError(resolve(args, androidOnly), /only work with web devices/);
});

deviceSelection.test('ambiguous auto-pick fails instead of using the first device', async () => {
  const args = ['inspect'];
  const deps = {
    ...androidOnly,
    pick: async () => {
      throw new Error('Multiple devices found but stdin is not a TTY.');
    },
  };
  await expectError(resolve(args, deps), /Multiple devices/);
});

deviceSelection.test('device names with spaces are still accepted', async () => {
  const args = ['inspect', '--device-name', 'Apple TV 4K (4th generation)'];
  const name = await resolve(args, {
    pick: async () => undefined,
    discover: async () => [{ id: 'EF2B4B7F', name: 'Apple TV 4K (4th generation)' }],
  });
  assert(name === 'EF2B4B7F', `got ${name}`);
});

deviceSelection.test('no device and nothing booted keeps the default session', async () => {
  const name = await resolve(['inspect'], {
    pick: async () => undefined,
    discover: async () => [],
  });
  assert(name === 'default', `got ${name}`);
});
