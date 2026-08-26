/**
 * Maps conductor key names to Roku ECP key strings.
 * Reference: the Roku External Control Protocol key list.
 */
import { Direction } from '../../utils.js';

/** Canonical key name (as listed in `press-key`) → ECP key. */
export const ROKU_ECP_KEYS: Record<string, string> = {
  'Remote Dpad Up': 'Up',
  'Remote Dpad Down': 'Down',
  'Remote Dpad Left': 'Left',
  'Remote Dpad Right': 'Right',
  'Remote Dpad Center': 'Select',
  Enter: 'Select',
  Return: 'Select',
  Back: 'Back',
  Escape: 'Back',
  Backspace: 'Backspace',
  Delete: 'Backspace',
  Home: 'Home',
  'Remote Media Play Pause': 'Play',
  'Remote Media Stop': 'Play', // Roku uses Play as a toggle
  'Remote Media Fast Forward': 'Fwd',
  'Remote Media Rewind': 'Rev',
  'Remote Media Next': 'Fwd',
  'Remote Media Previous': 'Rev',
  'Remote Menu': 'Info', // The * (options) button is Roku's menu
  'Remote Info': 'Info',
  'Remote Instant Replay': 'InstantReplay',
  'Remote Search': 'Search',
  Search: 'Search',
  Power: 'PowerOff',
  VolumeUp: 'VolumeUp',
  VolumeDown: 'VolumeDown',
  'Remote Button A': 'A',
  'Remote Button B': 'B',
};

/**
 * Key names reach us in several spellings — `Remote Dpad Up` from the CLI,
 * `REMOTE DPAD UP` from flow YAML, `VOLUME_UP` from the underscore convention —
 * so lookups compare on letters and digits alone.
 */
function normalizeKeyName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const BY_NORMALIZED = new Map(
  Object.entries(ROKU_ECP_KEYS).map(([name, key]) => [normalizeKeyName(name), key])
);

/** ECP key for a key name, matched loosely; undefined if unsupported. */
export function rokuEcpKey(name: string): string | undefined {
  return BY_NORMALIZED.get(normalizeKeyName(name));
}

/**
 * D-pad key for a swipe. A swipe drags the content, so it reveals what lies on the
 * far side: swiping up brings up what is *below*, which on a focus-driven UI is a
 * move down. Every direction inverts — matching Vega and web, where swiping up
 * increases the scroll offset.
 */
export function rokuSwipeKey(direction: Direction): string {
  switch (direction) {
    case 'up':
      return 'Down';
    case 'down':
      return 'Up';
    case 'left':
      return 'Right';
    case 'right':
      return 'Left';
  }
}
