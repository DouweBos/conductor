/**
 * Per-platform input backends for the streaming input server.
 *
 * The router works purely in normalized [0,1] coordinates and milliseconds;
 * each backend owns the device-specific translation (iOS points vs Android
 * pixels, gesture dt in seconds vs ms) and the keymaps. This is where
 * conductor takes ownership of coord→device and key-name→keycode, per the
 * migration design.
 */
import type { IOSDriver } from '../drivers/ios.js';
import type { AndroidDriver } from '../drivers/android.js';
import type { InputCapabilities, InputPlatform, LiveDragMode } from './input-protocol.js';

/** One finger's path in normalized space; `tMs` is the delay since this finger's previous step. */
export interface NormPath {
  steps: Array<{ nx: number; ny: number; tMs: number }>;
}

/**
 * Platform-agnostic input surface. All coordinates are normalized 0..1 and all
 * durations are milliseconds — backends convert to the driver's native units.
 */
export interface InputBackend {
  readonly platform: InputPlatform;
  capabilities(liveDrag: LiveDragMode): InputCapabilities;
  tap(nx: number, ny: number, durationMs?: number): Promise<void>;
  /** Multi-finger gesture playback (one NormPath per finger). */
  gesture(paths: NormPath[]): Promise<void>;
  swipe(nsx: number, nsy: number, nex: number, ney: number, durationMs: number): Promise<void>;
  text(value: string): Promise<void>;
  /** Press a key by web-style name; silently ignores names not mapped for the platform. */
  key(code: string, opts?: { down?: boolean; mods?: string[] }): Promise<void>;
  /** Press a hardware/remote button; silently ignores unmapped names. */
  button(name: string, holdMs?: number): Promise<void>;
}

const clampNorm = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// ── iOS / tvOS (XCUITest driver) ──────────────────────────────────────────────

// key-name → XCUITest pressKey value
const IOS_KEY: Record<string, 'delete' | 'return' | 'enter' | 'tab' | 'space'> = {
  Backspace: 'delete',
  Delete: 'delete',
  Enter: 'enter',
  Return: 'enter',
  Tab: 'tab',
  Space: 'space',
  ' ': 'space',
};

// button/key-name → XCUITest pressButton value
const IOS_BUTTON: Record<
  string,
  'home' | 'lock' | 'up' | 'down' | 'left' | 'right' | 'select' | 'menu' | 'playPause'
> = {
  home: 'home',
  Home: 'home',
  lock: 'lock',
  Lock: 'lock',
  power: 'lock',
  Power: 'lock',
  // tvOS remote (also reachable via the tvremote frame)
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  select: 'select',
  menu: 'menu',
  playPause: 'playPause',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

export function iosBackend(driver: IOSDriver): InputBackend {
  let size: { w: number; h: number } | null = null;
  const dims = async (): Promise<{ w: number; h: number }> => {
    if (!size) {
      const info = await driver.deviceInfo();
      size = { w: info.widthPoints, h: info.heightPoints };
    }
    return size;
  };
  const tvos = driver.platform === 'tvos';

  return {
    platform: tvos ? 'tvos' : 'ios',
    capabilities(liveDrag: LiveDragMode): InputCapabilities {
      return {
        touch: true,
        drag: true,
        multitouch: true,
        buttons: ['home', 'lock'],
        keyboard: true,
        text: true,
        tvRemote: tvos,
        springboard: true,
        liveDrag,
        binaryPointer: false,
        coord: 'normalized',
      };
    },
    async tap(nx, ny, durationMs) {
      const { w, h } = await dims();
      await driver.tap(
        clampNorm(nx) * w,
        clampNorm(ny) * h,
        durationMs ? durationMs / 1000 : undefined
      );
    },
    async gesture(paths) {
      const { w, h } = await dims();
      const converted = paths.map((p) => ({
        steps: p.steps.map((s) => ({
          x: clampNorm(s.nx) * w,
          y: clampNorm(s.ny) * h,
          dt: s.tMs / 1000,
        })),
      }));
      await driver.gesturePath(converted);
    },
    async swipe(nsx, nsy, nex, ney, durationMs) {
      const { w, h } = await dims();
      await driver.swipe(
        clampNorm(nsx) * w,
        clampNorm(nsy) * h,
        clampNorm(nex) * w,
        clampNorm(ney) * h,
        durationMs / 1000
      );
    },
    async text(value) {
      await driver.inputText(value);
    },
    async key(code, opts) {
      // XCUITest pressKey is atomic — act on key-down, ignore the paired up.
      if (opts && opts.down === false) return;
      const k = IOS_KEY[code];
      if (k) {
        await driver.pressKey(k);
        return;
      }
      const b = IOS_BUTTON[code];
      if (b) await driver.pressButton(b);
    },
    async button(name, holdMs) {
      const b = IOS_BUTTON[name];
      if (b) await driver.pressButton(b, holdMs ? holdMs / 1000 : undefined);
    },
  };
}

// ── Android (gRPC APK + adb) ───────────────────────────────────────────────────

const ANDROID_KEYCODE: Record<string, number> = {
  Home: 3,
  home: 3,
  Back: 4,
  back: 4,
  Enter: 66,
  Return: 66,
  Backspace: 67,
  Delete: 67,
  Tab: 61,
  Space: 62,
  ' ': 62,
  Escape: 111,
  Lock: 26,
  Power: 26,
  power: 26,
  VolumeUp: 24,
  volumeUp: 24,
  VolumeDown: 25,
  volumeDown: 25,
  Menu: 82,
  menu: 82,
  Search: 84,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  up: 19,
  down: 20,
  left: 21,
  right: 22,
  select: 23,
  playPause: 85,
};

export function androidBackend(driver: AndroidDriver): InputBackend {
  let size: { w: number; h: number } | null = null;
  const dims = async (): Promise<{ w: number; h: number }> => {
    if (!size) {
      const info = await driver.deviceInfo();
      size = { w: info.widthPixels, h: info.heightPixels };
    }
    return size;
  };

  return {
    platform: 'android',
    capabilities(liveDrag: LiveDragMode): InputCapabilities {
      return {
        touch: true,
        drag: true,
        multitouch: true,
        buttons: ['home', 'back', 'menu', 'power', 'volumeUp', 'volumeDown'],
        keyboard: true,
        text: true,
        tvRemote: true, // Android-TV dpad via keyevents
        springboard: false,
        liveDrag,
        binaryPointer: false,
        coord: 'normalized',
      };
    },
    async tap(nx, ny) {
      const { w, h } = await dims();
      await driver.tap(clampNorm(nx) * w, clampNorm(ny) * h);
    },
    async gesture(paths) {
      const { w, h } = await dims();
      const converted = paths.map((p) => ({
        steps: p.steps.map((s) => ({
          x: clampNorm(s.nx) * w,
          y: clampNorm(s.ny) * h,
          dt_ms: Math.round(s.tMs),
        })),
      }));
      await driver.gesturePath(converted);
    },
    async swipe(nsx, nsy, nex, ney, durationMs) {
      const { w, h } = await dims();
      await driver.swipe(
        clampNorm(nsx) * w,
        clampNorm(nsy) * h,
        clampNorm(nex) * w,
        clampNorm(ney) * h,
        durationMs
      );
    },
    async text(value) {
      await driver.inputText(value);
    },
    async key(code, opts) {
      if (opts && opts.down === false) return;
      const kc = ANDROID_KEYCODE[code];
      if (kc !== undefined) await driver.pressKeyEvent(kc);
    },
    async button(name) {
      const kc = ANDROID_KEYCODE[name];
      if (kc !== undefined) await driver.pressKeyEvent(kc);
    },
  };
}
