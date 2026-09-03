export const HELP = `  press-key <key>                     Press a key (Enter, Backspace, Home, ...)
    --long-press                      Hold the button ~1.5s (tvOS remote buttons)
    --duration <seconds>              Hold for a custom duration (tvOS remote buttons)
    --measure                         Time the app's response to the press
    --repeat <n>                      With --measure, take n samples and report a distribution
    --sequence <k1,k2,...>            With --repeat, cycle these keys so focus oscillates
    --timeout <ms>                    With --measure, give up on a sample after n ms (default 3000)
    --poll-interval <ms>              With --measure, delay between focus polls (default 0)
    --settle <ms>                     With --measure on Android, render time to allow (default 700)`;

import { runDirect } from '../runner.js';
import { printSuccess, printError, printData, OutputOptions } from '../output.js';
import { measureKeyLatency, printLatencyReport, MeasureOptions } from './input-latency.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';
import { WebDriver } from '../drivers/web.js';
import { VegaDriver } from '../drivers/vega.js';
import { VegaButton } from '../drivers/vega/input.js';
import { RokuDriver } from '../drivers/roku.js';
import { rokuEcpKey } from '../drivers/roku/key-mapping.js';
import type { IOSButton } from '../drivers/ios.js';

export const VALID_KEYS = [
  'Enter',
  'Backspace',
  'Home',
  'End',
  'Tab',
  'Delete',
  'Escape',
  'VolumeUp',
  'VolumeDown',
  'Power',
  'Lock',
  'Back',
  'Camera',
  'Search',
  'Remote Dpad Up',
  'Remote Dpad Down',
  'Remote Dpad Left',
  'Remote Dpad Right',
  'Remote Dpad Center',
  'Remote Media Play Pause',
  'Remote Media Stop',
  'Remote Media Next',
  'Remote Media Previous',
  'Remote Media Rewind',
  'Remote Media Fast Forward',
  'Remote System Navigation Up',
  'Remote System Navigation Down',
  'Remote Button A',
  'Remote Button B',
  'Remote Menu',
  'TV Input',
  'TV Input HDMI 1',
  'TV Input HDMI 2',
  'TV Input HDMI 3',
  'Remote Info',
  'Remote Instant Replay',
  'Remote Search',
  'Remote Page Up',
  'Remote Page Down',
  'Remote Guide',
  'Remote TV Provider',
  'Remote One Two Three',
  'Remote Four Colors',
] as const;

export type Key = (typeof VALID_KEYS)[number];

// iOS XCTest pressKey accepts these values (maps to XCUIKeyboardKey)
const IOS_KEY_MAP: Partial<Record<Key, 'delete' | 'return' | 'enter' | 'tab' | 'space'>> = {
  Backspace: 'delete',
  Delete: 'delete',
  Enter: 'enter',
  Tab: 'tab',
};

// iOS pressButton for hardware buttons
const IOS_BUTTON_MAP: Partial<Record<Key, 'home' | 'lock'>> = {
  Home: 'home',
  Lock: 'lock',
  Power: 'lock',
};

// tvOS remote: map key names to pressButton values
// Page Up/Down and Guide need tvOS 14.3; the last three need tvOS 18.1. The
// driver reports a precondition error when the device's OS is older.
export const TVOS_REMOTE_BUTTONS: Partial<Record<Key, IOSButton>> = {
  'Remote Dpad Up': 'up',
  'Remote Dpad Down': 'down',
  'Remote Dpad Left': 'left',
  'Remote Dpad Right': 'right',
  'Remote Dpad Center': 'select',
  'Remote Menu': 'menu',
  'Remote Media Play Pause': 'playPause',
  'Remote Page Up': 'pageUp',
  'Remote Page Down': 'pageDown',
  'Remote Guide': 'guide',
  'Remote TV Provider': 'tvProvider',
  'Remote One Two Three': 'oneTwoThree',
  'Remote Four Colors': 'fourColors',
};

// vega (Amazon Fire TV) remote: map key names to VegaDriver button values.
const VEGA_REMOTE_BUTTONS: Partial<Record<Key, VegaButton>> = {
  'Remote Dpad Up': 'up',
  'Remote Dpad Down': 'down',
  'Remote Dpad Left': 'left',
  'Remote Dpad Right': 'right',
  'Remote Dpad Center': 'select',
  'Remote Menu': 'menu',
  'Remote Media Play Pause': 'playPause',
  'Remote Media Rewind': 'rewind',
  'Remote Media Fast Forward': 'fastForward',
  Home: 'home',
  Back: 'back',
  VolumeUp: 'volumeUp',
  VolumeDown: 'volumeDown',
};

// Android keyevent codes
export const ANDROID_KEYCODE: Partial<Record<Key, number>> = {
  Home: 3,
  Back: 4,
  Enter: 66,
  Backspace: 67,
  Delete: 67,
  Tab: 61,
  Lock: 26,
  Power: 26,
  VolumeUp: 24,
  VolumeDown: 25,
  Camera: 27,
  Search: 84,
  Escape: 111,
  End: 123,
  // Android TV remote keys
  'Remote Dpad Up': 19,
  'Remote Dpad Down': 20,
  'Remote Dpad Left': 21,
  'Remote Dpad Right': 22,
  'Remote Dpad Center': 23,
  'Remote Media Play Pause': 85,
  'Remote Media Stop': 86,
  'Remote Media Next': 87,
  'Remote Media Previous': 88,
  'Remote Media Rewind': 89,
  'Remote Media Fast Forward': 90,
  'Remote System Navigation Up': 280,
  'Remote System Navigation Down': 281,
  'Remote Button A': 96,
  'Remote Button B': 97,
  'Remote Menu': 82,
  'TV Input': 178,
  'TV Input HDMI 1': 243,
  'TV Input HDMI 2': 244,
  'TV Input HDMI 3': 245,
  'Remote Info': 165,
  'Remote Instant Replay': 273, // KEYCODE_MEDIA_SKIP_BACKWARD
  'Remote Search': 84,
  // Paging keys — the fast way through a long list. Whether a given app honours
  // them varies, the same as on tvOS.
  'Remote Page Up': 92,
  'Remote Page Down': 93,
};

export type AnyDriver = IOSDriver | AndroidDriver | WebDriver | VegaDriver | RokuDriver;

/**
 * Send `key` on an already-connected driver. Split out of `pressKey` so
 * `--measure` can reuse one driver across repeats instead of paying driver
 * setup on every sample.
 */
export async function dispatchKey(
  driver: AnyDriver,
  matched: Key,
  holdSeconds?: number
): Promise<void> {
  if (driver instanceof IOSDriver) {
    if (driver.platform === 'tvos') {
      const tvosButton = TVOS_REMOTE_BUTTONS[matched];
      const iosButton = IOS_BUTTON_MAP[matched];
      if (tvosButton) {
        await driver.pressButton(tvosButton, holdSeconds);
      } else if (iosButton) {
        await driver.pressButton(iosButton, holdSeconds);
      }
      // Keys not mapped on tvOS are silently ignored
    } else {
      const iosKey = IOS_KEY_MAP[matched];
      const iosButton = IOS_BUTTON_MAP[matched];
      if (iosKey) {
        await driver.pressKey(iosKey);
      } else if (iosButton) {
        await driver.pressButton(iosButton);
      }
      // Keys not mapped on iOS (e.g. Back, VolumeUp) are silently ignored
    }
  } else if (driver instanceof WebDriver) {
    const WEB_KEY_MAP: Partial<Record<Key, string>> = {
      Enter: 'Enter',
      Tab: 'Tab',
      Backspace: 'Backspace',
      Delete: 'Delete',
      Escape: 'Escape',
      Home: 'Home',
      End: 'End',
      // Canvas webtv apps (Lightning/WPE) navigate focus via the D-pad, which they listen
      // for as arrow keys (and Enter for select). Maps the TV remote onto web keyboard.
      'Remote Dpad Up': 'ArrowUp',
      'Remote Dpad Down': 'ArrowDown',
      'Remote Dpad Left': 'ArrowLeft',
      'Remote Dpad Right': 'ArrowRight',
      'Remote Dpad Center': 'Enter',
    };
    const webKey = WEB_KEY_MAP[matched];
    if (webKey) {
      await driver.pressKey(webKey);
    }
  } else if (driver instanceof VegaDriver) {
    const vegaButton = VEGA_REMOTE_BUTTONS[matched];
    if (vegaButton) {
      await driver.pressButton(vegaButton);
    }
    // Keys not mapped on vega are silently ignored
  } else if (driver instanceof RokuDriver) {
    // Keys not mapped on roku are silently ignored, as on tvOS and vega — but a
    // mapped key that the device rejects must still fail.
    if (rokuEcpKey(matched)) {
      await driver.pressKeyNamed(matched);
    }
  } else if (driver instanceof AndroidDriver) {
    const code = ANDROID_KEYCODE[matched];
    if (code !== undefined) {
      await driver.pressKeyEvent(code);
    }
  }
}

export async function pressKey(
  key: string,
  opts: OutputOptions = {},
  sessionName = 'default',
  flags: {
    longPress?: boolean;
    duration?: number;
    measure?: boolean;
    repeat?: number;
    timeoutMs?: number;
    pollIntervalMs?: number;
    settleMs?: number;
    sequence?: string[];
    appId?: string;
  } = {}
): Promise<number> {
  // A held press is requested via --long-press (default 1.5s) or an explicit --duration.
  const holdSeconds = flags.duration ?? (flags.longPress ? 1.5 : undefined);

  if (!key) {
    printError(`press-key requires <key>. Valid keys: ${VALID_KEYS.join(', ')}`, opts);
    return 1;
  }

  const matched = VALID_KEYS.find((k) => k.toLowerCase() === key.toLowerCase());
  if (!matched) {
    printError(`Unknown key "${key}". Valid keys: ${VALID_KEYS.join(', ')}`, opts);
    return 1;
  }

  if (flags.measure) {
    const sequence: Key[] = [matched];
    for (const raw of flags.sequence ?? []) {
      const k = VALID_KEYS.find((v) => v.toLowerCase() === raw.trim().toLowerCase());
      if (!k) {
        printError(
          `Unknown key "${raw}" in --sequence. Valid keys: ${VALID_KEYS.join(', ')}`,
          opts
        );
        return 1;
      }
      sequence.push(k);
    }
    const measureOpts: MeasureOptions = {
      repeat: flags.repeat ?? 1,
      timeoutMs: flags.timeoutMs ?? 3000,
      pollIntervalMs: flags.pollIntervalMs ?? 0,
      settleMs: flags.settleMs ?? 700,
      appId: flags.appId,
      holdSeconds,
    };
    try {
      const report = await measureKeyLatency(sessionName, sequence, measureOpts);
      if (opts.json) printData({ status: 'ok', ...report }, opts);
      else printLatencyReport(report);
      // Nothing measurable at all is a failure; boundary refusals are not.
      return report.outcomes.moved === 0 && !report.pressToFrame ? 1 : 0;
    } catch (err) {
      printError(
        `press-key ${matched} --measure — ${err instanceof Error ? err.message : String(err)}`,
        opts
      );
      return 1;
    }
  }

  const result = await runDirect(
    (driver) => dispatchKey(driver, matched, holdSeconds),
    sessionName
  );

  if (result.success) {
    printSuccess(`press-key ${matched} — done`, opts);
    return 0;
  } else {
    printError(`press-key ${matched} — failed\n${result.stderr}`, opts);
    return 1;
  }
}
