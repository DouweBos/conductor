/**
 * Driver client for Roku devices, reached over the network via the External
 * Control Protocol (ECP — an HTTP REST API on device port 8060). Roku has no
 * on-device driver process and no local control port; every operation is a
 * stateless ECP call:
 *  - view hierarchy from `/query/app-ui` (SceneGraph XML, dev-mode channels only),
 *    re-emitted as uiautomator XML so the Android element resolver handles it,
 *  - input via `/keypress/<key>` (D-pad focus navigation — there is no touch),
 *  - text via character-by-character `LIT_` keypresses,
 *  - screenshots via the dev web server's `/plugin_inspect` (digest auth with
 *    `CONDUCTOR_ROKU_PASSWORD`),
 *  - app lifecycle via `/launch/<channelId>`.
 *
 * Physical hardware only — Roku has no emulator. The device must be in developer
 * mode with "Control by mobile apps" network access set to Permissive.
 */
import { RokuEcpClient, RokuDeviceDetails } from './roku/ecp-client.js';
import { rokuPassword } from './roku/discovery.js';
import { rokuEcpKey, rokuSwipeKey } from './roku/key-mapping.js';
import { parseRokuAppUI } from './roku/app-ui-parser.js';
import { Direction } from '../utils.js';
import { sleep } from '../utils.js';
import { log } from '../verbose.js';

export interface RokuDeviceInfo {
  widthPixels: number;
  heightPixels: number;
}

const LAUNCH_TIMEOUT_MS = 10_000;
const EXIT_TIMEOUT_MS = 5_000;
const LONG_PRESS_MS = 1_000;
const SWIPE_KEY_PRESSES = 5;

const UNSUPPORTED = (op: string): Error => new Error(`${op} is not supported on roku`);

export class RokuDriver {
  readonly platform = 'roku' as const;
  private readonly ecp: RokuEcpClient;
  private deviceDetails: RokuDeviceDetails | null = null;

  /** `host` is the bare device IP/hostname, not the `roku:` id. */
  constructor(readonly host: string) {
    this.ecp = new RokuEcpClient(host, { password: rokuPassword() });
  }

  async isAlive(): Promise<boolean> {
    return this.ecp.isReachable();
  }

  async deviceInfo(): Promise<RokuDeviceInfo> {
    const info = await this.resolveDetails();
    return { widthPixels: info.widthPixels, heightPixels: info.heightPixels };
  }

  /** Cached: the hierarchy path reads this, so an uncached miss is an extra round trip per command. */
  private async resolveDetails(): Promise<RokuDeviceDetails> {
    if (this.deviceDetails) return this.deviceDetails;
    const info = await this.ecp.getDeviceInfo();
    if (!info) throw new Error(`Failed to read device info from the Roku device at ${this.host}`);
    this.deviceDetails = info;
    return info;
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  /** Roku is D-pad based: there is no coordinate tap, so Select activates whatever holds focus. */
  async tap(_x: number, _y: number, duration?: number): Promise<void> {
    if (duration && duration >= 0.5) {
      await this.longPress(_x, _y);
      return;
    }
    log('roku: tap() maps to a Select keypress (Roku is D-pad based)');
    await this.ecp.sendKeypress('Select');
  }

  async longPress(_x: number, _y: number): Promise<void> {
    // Some Roku channels respond to a held Select key.
    await this.ecp.sendKeyDown('Select');
    await sleep(LONG_PRESS_MS);
    await this.ecp.sendKeyUp('Select');
  }

  /**
   * A swipe on Roku is repeated D-pad presses in the direction the *content*
   * moves, which is the opposite of the direction the finger travels.
   */
  async swipe(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    _durationMs: number
  ): Promise<void> {
    const dx = endX - startX;
    const dy = endY - startY;
    const direction: Direction =
      Math.abs(dy) > Math.abs(dx) ? (dy < 0 ? 'up' : 'down') : dx < 0 ? 'left' : 'right';
    await this.swipeDirection(direction);
  }

  async swipeDirection(direction: Direction): Promise<void> {
    const key = rokuSwipeKey(direction);
    for (let i = 0; i < SWIPE_KEY_PRESSES; i++) await this.ecp.sendKeypress(key);
  }

  /** Sends a key by its conductor name (e.g. `Remote Dpad Up`). Throws if unmapped. */
  async pressKeyNamed(name: string): Promise<void> {
    const key = rokuEcpKey(name);
    if (!key) throw new Error(`Key "${name}" is not supported on roku`);
    await this.ecp.sendKeypress(key);
  }

  async back(): Promise<void> {
    await this.ecp.sendKeypress('Back');
  }

  async inputText(text: string): Promise<void> {
    await this.ecp.sendText(text);
  }

  async eraseAllText(charactersToErase = 50): Promise<void> {
    for (let i = 0; i < charactersToErase; i++) await this.ecp.sendKeypress('Backspace');
  }

  // ── Inspection ─────────────────────────────────────────────────────────────

  /** Returns uiautomator-style XML (consumed by the Android element resolver). */
  async viewHierarchy(): Promise<string> {
    const xml = await this.ecp.getAppUIRaw();
    if (xml === null) {
      throw new Error(
        `Failed to read the view hierarchy from the Roku device at ${this.host}. ` +
          `Check ECP network access (Settings > System > Advanced system settings > ` +
          `Control by mobile apps > Network access > Permissive), and note that ` +
          `/query/app-ui only reports sideloaded dev-mode channels.`
      );
    }
    const info = await this.resolveDetails().catch(() => null);
    return parseRokuAppUI(xml, info?.widthPixels, info?.heightPixels);
  }

  async screenshot(_opts: { fullPage?: boolean } = {}): Promise<Buffer> {
    return this.ecp.takeScreenshot();
  }

  // ── App lifecycle ──────────────────────────────────────────────────────────

  /**
   * Cold launch. ECP has no terminate endpoint and `launch` resumes an already
   * running channel with its state intact, so exit to the home screen first to
   * force a restart from the channel's initial state.
   */
  async launchApp(appId: string, args?: Record<string, string>): Promise<void> {
    if (await this.ecp.isActiveApp(appId)) {
      await this.ecp.sendKeypress('Home');
      const exitDeadline = Date.now() + EXIT_TIMEOUT_MS;
      while (Date.now() < exitDeadline && (await this.ecp.isActiveApp(appId))) {
        await sleep(200);
      }
    }

    await this.ecp.launchChannel(appId, args ?? {});

    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    let active = false;
    while (Date.now() < deadline) {
      if (await this.ecp.isActiveApp(appId)) {
        active = true;
        break;
      }
      await sleep(200);
    }
    if (!active) {
      // Returning here would leave the flow asserting against whatever screen the
      // device happens to show, failing later with an unrelated message.
      throw new Error(
        `Roku channel ${appId} did not become the active app within ${LAUNCH_TIMEOUT_MS}ms. ` +
          `Check the channel id (a sideloaded channel is \`dev\`) and that it is installed.`
      );
    }

    // Wait for the channel UI to render — a SceneGraph screen with child nodes.
    while (Date.now() < deadline) {
      const xml = await this.ecp.getAppUIRaw();
      if (xml && /<screen\b[^>]*>\s*</.test(xml)) return;
      await sleep(500);
    }
    log(`roku: channel ${appId} launched but its UI may not be fully rendered`);
  }

  /** Roku has no "stop app" ECP endpoint — pressing Home exits the channel. */
  async stopApp(_appId: string): Promise<void> {
    await this.ecp.sendKeypress('Home');
  }

  async terminateApp(appId: string): Promise<void> {
    await this.stopApp(appId);
  }

  async getForegroundApp(): Promise<string> {
    const app = await this.ecp.getActiveApp();
    if (!app?.id) throw new Error('Could not determine the active Roku channel');
    return app.id;
  }

  /**
   * Roku deep links are a `contentId` launch parameter on a channel, so a link
   * needs a channel to open it. Callers pass only a URL, so this targets the
   * channel already in the foreground — the one the flow is testing.
   */
  async openLink(url: string, appId?: string): Promise<void> {
    const channel = appId ?? (await this.ecp.getActiveApp())?.id;
    if (!channel) {
      throw new Error(
        'open-link on roku needs a channel to open the link in, and none is active. ' +
          'Launch the channel first (`conductor launch-app <channelId>`), or pass the ' +
          'link as a launch argument.'
      );
    }
    await this.ecp.launchChannel(channel, { contentId: url });
  }

  // ── Unsupported on roku (gated with clear errors) ───────────────────────────

  async installApp(_path: string): Promise<void> {
    throw new Error(
      'install-app is not supported on roku — sideload the channel through the ' +
        "device's developer web server (http://<device-ip>)."
    );
  }

  async uninstallApp(_appId: string): Promise<void> {
    throw UNSUPPORTED('uninstall-app');
  }

  async listInstalledApps(): Promise<string[]> {
    throw UNSUPPORTED('list-apps');
  }

  async clearAppState(_appId: string): Promise<void> {
    throw new Error(
      'clear-state is not supported on roku — re-sideload the channel to reset its state.'
    );
  }

  async clearKeychain(): Promise<void> {
    // Not applicable on Roku — no-op.
  }

  async setLocation(_latitude: number, _longitude: number): Promise<void> {
    throw UNSUPPORTED('set-location');
  }

  async setOrientation(_orientation: string): Promise<void> {
    // No-op: TVs don't rotate.
  }

  async setPermissions(_appId: string, _permissions: Record<string, string>): Promise<void> {
    // No runtime-permission grant primitive on Roku — no-op.
  }

  async addMedia(_filePath: string): Promise<void> {
    throw UNSUPPORTED('add-media');
  }

  async setAirplaneMode(_enabled: boolean): Promise<void> {
    throw UNSUPPORTED('airplane mode');
  }

  async getAirplaneMode(): Promise<boolean> {
    throw UNSUPPORTED('airplane mode');
  }

  async gesturePath(
    _paths: Array<{ steps: Array<{ x: number; y: number; dt: number }> }>
  ): Promise<void> {
    throw UNSUPPORTED('multi-finger gestures');
  }

  async startRecording(_outputPath: string): Promise<void> {
    throw UNSUPPORTED('screen recording');
  }

  async stopRecording(): Promise<void> {
    throw UNSUPPORTED('screen recording');
  }

  async clipboardRead(): Promise<string> {
    throw UNSUPPORTED('clipboard');
  }

  async clipboardWrite(_text: string): Promise<void> {
    throw UNSUPPORTED('clipboard');
  }
}
