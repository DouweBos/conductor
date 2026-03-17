export const HELP = `  press-key <key>                     Press a key (Enter, Backspace, Home, ...)`;

import { runDirect } from '../runner.js';
import { printSuccess, printError, OutputOptions } from '../output.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';

const VALID_KEYS = [
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
] as const;

type Key = (typeof VALID_KEYS)[number];

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

// Android keyevent codes
const ANDROID_KEYCODE: Partial<Record<Key, number>> = {
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
};

export async function pressKey(
  key: string,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  if (!key) {
    printError(`press-key requires <key>. Valid keys: ${VALID_KEYS.join(', ')}`, opts);
    return 1;
  }

  const matched = VALID_KEYS.find((k) => k.toLowerCase() === key.toLowerCase());
  if (!matched) {
    printError(`Unknown key "${key}". Valid keys: ${VALID_KEYS.join(', ')}`, opts);
    return 1;
  }

  const result = await runDirect(async (driver) => {
    if (driver instanceof IOSDriver) {
      const iosKey = IOS_KEY_MAP[matched];
      const iosButton = IOS_BUTTON_MAP[matched];
      if (iosKey) {
        await driver.pressKey(iosKey);
      } else if (iosButton) {
        await driver.pressButton(iosButton);
      }
      // Keys not mapped on iOS (e.g. Back, VolumeUp) are silently ignored
    } else if (driver instanceof AndroidDriver) {
      const code = ANDROID_KEYCODE[matched];
      if (code !== undefined) {
        await driver.pressKeyEvent(code);
      }
    }
  }, sessionName);

  if (result.success) {
    printSuccess(`press-key ${matched} — done`, opts);
    return 0;
  } else {
    printError(`press-key ${matched} — failed\n${result.stderr}`, opts);
    return 1;
  }
}
