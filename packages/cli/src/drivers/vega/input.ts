/**
 * Input injection for Vega via the stock on-device `inputd-cli`, run over
 * `vega … run-cmd`.
 *
 * `inputd-cli` drives the real remote/navigation input the Cartesian focus engine
 * acts on. It requires the device's **developer mode** to be on (otherwise the
 * on-device dev-shell service that hosts it is down and every command fails);
 * {@link ensureInputAvailable} probes for this and raises an actionable error.
 */
import { VegaDeviceConnection } from './connection.js';

const SETTLE_MS = 300;
const LONG_PRESS_MS = 1000;

/** Conductor remote-button name → Linux input KEY_ name accepted by `button_press`. */
export type VegaButton =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'select'
  | 'menu'
  | 'home'
  | 'back'
  | 'playPause'
  | 'rewind'
  | 'fastForward'
  | 'volumeUp'
  | 'volumeDown';

// Verified key names (via Maestro): select is KEY_ENTER (KEY_SELECT is a no-op),
// home is KEY_HOMEPAGE (KEY_HOME is inert), back is KEY_BACK.
export const VEGA_BUTTON_KEYS: Record<VegaButton, string> = {
  up: 'KEY_UP',
  down: 'KEY_DOWN',
  left: 'KEY_LEFT',
  right: 'KEY_RIGHT',
  select: 'KEY_ENTER',
  menu: 'KEY_MENU',
  home: 'KEY_HOMEPAGE',
  back: 'KEY_BACK',
  playPause: 'KEY_PLAYPAUSE',
  rewind: 'KEY_REWIND',
  fastForward: 'KEY_FASTFORWARD',
  volumeUp: 'KEY_VOLUMEUP',
  volumeDown: 'KEY_VOLUMEDOWN',
};

export class VegaInputUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VegaInputUnavailableError';
  }
}

export class VegaInput {
  private inputChecked = false;

  constructor(private readonly connection: VegaDeviceConnection) {}

  /** Probe the input channel once; raises an actionable error if dev mode is off. */
  async ensureInputAvailable(): Promise<void> {
    if (this.inputChecked) return;
    const size = await this.connection.screenSize().catch(() => null);
    if (!size) {
      throw new VegaInputUnavailableError(
        'Vega input is unavailable: `inputd-cli` could not be reached over the device shell, ' +
          "which means the VVD's developer mode is off. Enable it (`vsm developer-mode enable`, " +
          'e.g. via `vega device shell`) and retry.'
      );
    }
    this.inputChecked = true;
  }

  async pressButton(button: VegaButton): Promise<void> {
    const keyName = VEGA_BUTTON_KEYS[button];
    if (!keyName) throw new Error(`Button "${button}" is not supported on Vega`);
    await this.buttonPress(keyName);
  }

  async buttonPress(keyName: string): Promise<void> {
    await this.ensureInputAvailable();
    await this.connection.shell(`inputd-cli button_press ${keyName}`);
    await settle();
  }

  async tap(x: number, y: number): Promise<void> {
    await this.ensureInputAvailable();
    await this.connection.shell(`inputd-cli touch ${Math.round(x)} ${Math.round(y)}`);
    await settle();
  }

  async longPress(x: number, y: number): Promise<void> {
    await this.ensureInputAvailable();
    // Vega expresses a long press via the hold duration on a touch.
    await this.connection.shell(
      `inputd-cli touch ${Math.round(x)} ${Math.round(y)} --holdDuration ${LONG_PRESS_MS}`
    );
    await settle();
  }

  async swipe(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    durationMs: number
  ): Promise<void> {
    await this.ensureInputAvailable();
    await this.connection.shell(
      `inputd-cli swipe ${Math.round(startX)} ${Math.round(startY)} ` +
        `${Math.round(endX)} ${Math.round(endY)} --interval ${Math.round(durationMs)}`
    );
    await settle();
  }

  async inputText(text: string): Promise<void> {
    if (text.includes('\n') || text.includes('\r')) {
      throw new Error('Vega keyboard text must not contain newlines');
    }
    await this.ensureInputAvailable();
    await this.connection.shell(`inputd-cli send_text ${shellQuote(text)}`);
    await settle();
  }

  async eraseText(charactersToErase: number): Promise<void> {
    await this.ensureInputAvailable();
    for (let i = 0; i < charactersToErase; i++) {
      await this.connection.shell('inputd-cli button_press KEY_BACKSPACE');
    }
    await settle();
  }
}

function settle(): Promise<void> {
  // Give the focus engine time to keep up (CI's software renderer is slow).
  return new Promise((r) => setTimeout(r, SETTLE_MS));
}

/** Single-quote a string for a POSIX device shell, escaping embedded quotes. */
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
