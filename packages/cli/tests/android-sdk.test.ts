/**
 * Tests for the Android SDK tool resolver.
 *
 * Verifies tool resolution against env vars, the macOS default location, and
 * the PATH-fallback behavior. Uses a temp-dir SDK layout instead of mocking fs
 * so we exercise the real lookup path.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TestSuite, assert, runAll } from './runner.js';
import {
  resolveAndroidTool,
  findAndroidSdkRoot,
  ensureAndroidEnv,
  androidSpawnEnv,
} from '../src/android/sdk.js';

export const androidSdk = new TestSuite('android sdk resolver');

function makeFakeSdk(layout: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-sdk-'));
  for (const rel of layout) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  return root;
}

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

androidSdk.test('resolves emulator/adb/avdmanager/sdkmanager from ANDROID_HOME', () => {
  const root = makeFakeSdk([
    'emulator/emulator',
    'platform-tools/adb',
    'cmdline-tools/latest/bin/avdmanager',
    'cmdline-tools/latest/bin/sdkmanager',
  ]);
  withEnv({ ANDROID_HOME: root, ANDROID_SDK_ROOT: undefined }, () => {
    assert(
      resolveAndroidTool('emulator') === path.join(root, 'emulator/emulator'),
      'emulator should resolve under ANDROID_HOME'
    );
    assert(
      resolveAndroidTool('adb') === path.join(root, 'platform-tools/adb'),
      'adb should resolve under ANDROID_HOME'
    );
    assert(
      resolveAndroidTool('avdmanager') === path.join(root, 'cmdline-tools/latest/bin/avdmanager'),
      'avdmanager should resolve under cmdline-tools/latest/bin'
    );
    assert(
      resolveAndroidTool('sdkmanager') === path.join(root, 'cmdline-tools/latest/bin/sdkmanager'),
      'sdkmanager should resolve under cmdline-tools/latest/bin'
    );
    assert(findAndroidSdkRoot() === root, 'findAndroidSdkRoot should return the env root');
  });
  fs.rmSync(root, { recursive: true, force: true });
  return Promise.resolve();
});

androidSdk.test('falls back to bare command name when no SDK found', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-fakehome-'));
  withEnv(
    {
      ANDROID_HOME: undefined,
      ANDROID_SDK_ROOT: undefined,
      LOCALAPPDATA: undefined,
      HOME: fakeHome,
    },
    () => {
      // homedir() honors $HOME on POSIX; on darwin we still need to ensure the
      // default macOS path doesn't accidentally exist under the fake home.
      assert(
        resolveAndroidTool('adb') === 'adb',
        `expected bare "adb" with empty SDK; got ${resolveAndroidTool('adb')}`
      );
      assert(findAndroidSdkRoot() === undefined, 'no root expected');
    }
  );
  fs.rmSync(fakeHome, { recursive: true, force: true });
  return Promise.resolve();
});

androidSdk.test('falls back to legacy tools/bin for avdmanager/sdkmanager', () => {
  const root = makeFakeSdk(['tools/bin/avdmanager', 'tools/bin/sdkmanager']);
  withEnv({ ANDROID_HOME: root, ANDROID_SDK_ROOT: undefined }, () => {
    assert(
      resolveAndroidTool('avdmanager') === path.join(root, 'tools/bin/avdmanager'),
      'avdmanager should fall back to tools/bin'
    );
    assert(
      resolveAndroidTool('sdkmanager') === path.join(root, 'tools/bin/sdkmanager'),
      'sdkmanager should fall back to tools/bin'
    );
  });
  fs.rmSync(root, { recursive: true, force: true });
  return Promise.resolve();
});

androidSdk.test('ANDROID_SDK_ROOT is used when ANDROID_HOME is unset', () => {
  const root = makeFakeSdk(['platform-tools/adb']);
  withEnv({ ANDROID_HOME: undefined, ANDROID_SDK_ROOT: root }, () => {
    assert(
      resolveAndroidTool('adb') === path.join(root, 'platform-tools/adb'),
      'adb should resolve via ANDROID_SDK_ROOT'
    );
  });
  fs.rmSync(root, { recursive: true, force: true });
  return Promise.resolve();
});

androidSdk.test('androidSpawnEnv injects ANDROID_HOME/SDK_ROOT when unset', () => {
  const root = makeFakeSdk(['platform-tools/adb']);
  withEnv({ ANDROID_HOME: undefined, ANDROID_SDK_ROOT: root }, () => {
    const env = androidSpawnEnv();
    // ANDROID_SDK_ROOT was already exported, so kept as-is; ANDROID_HOME is
    // filled in from the discovered root so child processes (esp. emulator)
    // see a complete env.
    assert(env.ANDROID_SDK_ROOT === root, 'existing ANDROID_SDK_ROOT preserved');
    assert(env.ANDROID_HOME === root, `ANDROID_HOME should be set; got ${String(env.ANDROID_HOME)}`);
  });
  fs.rmSync(root, { recursive: true, force: true });
  return Promise.resolve();
});

androidSdk.test('ensureAndroidEnv is callable and idempotent', () => {
  // Just verify it doesn't throw and is safe to call repeatedly. The actual
  // mutation depends on whether a real SDK is installed on the test host, so
  // we don't assert on process.env values here.
  ensureAndroidEnv();
  ensureAndroidEnv();
  return Promise.resolve();
});

if (require.main === module) runAll([androidSdk]);
