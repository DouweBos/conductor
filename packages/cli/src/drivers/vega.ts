/**
 * Driver client for Amazon Vega (Fire TV) devices. Vega is a Linux/React Native
 * OS (not Android), reached through Amazon's `vega`/`kepler` CLI — there is no
 * XCTest/gRPC driver process and no local control port. This class is a
 * standalone, stateless client that shells out to the CLI plus the on-device
 * automation toolkit:
 *  - view hierarchy from the toolkit (JSON-RPC on device port 8383), re-emitted
 *    as uiautomator XML so the Android element resolver handles it,
 *  - input via the stock `inputd-cli` (D-pad button_press, touch, swipe, send_text),
 *  - screenshots via the toolkit's `takeScreenshot`,
 *  - app lifecycle via `vega device …`.
 *
 * v1 targets the Vega Virtual Device (VVD); physical Fire TV sticks reuse the
 * same path.
 */
import { VegaCli } from './vega/cli.js';
import { VegaDeviceConnection } from './vega/connection.js';
import { VegaAutomationClient } from './vega/automation-client.js';
import { VegaInput, VegaButton } from './vega/input.js';
import { parseVegaPageSource } from './vega/page-source-parser.js';

export interface VegaDeviceInfo {
  widthPixels: number;
  heightPixels: number;
}

const UNSUPPORTED = (op: string): Error =>
  new Error(`${op} is not supported on vega (Amazon Fire TV)`);

export class VegaDriver {
  readonly platform = 'vega' as const;
  private readonly cli: VegaCli;
  private readonly connection: VegaDeviceConnection;
  private readonly automation: VegaAutomationClient;
  private readonly input: VegaInput;
  private screenSize: { width: number; height: number } | null = null;

  /** `serial` is the bare Vega selector (e.g. `VirtualDevice`), not the `vega:` id. */
  constructor(readonly serial: string) {
    this.cli = new VegaCli(serial);
    this.connection = new VegaDeviceConnection(serial, this.cli);
    this.automation = new VegaAutomationClient(this.connection);
    this.input = new VegaInput(this.connection);
  }

  async isAlive(): Promise<boolean> {
    const devices = await this.cli.listDevices().catch(() => []);
    return devices.some((d) => d.serial === this.serial);
  }

  async deviceInfo(): Promise<VegaDeviceInfo> {
    const size = await this.resolveScreenSize();
    return { widthPixels: size.width, heightPixels: size.height };
  }

  private async resolveScreenSize(): Promise<{ width: number; height: number }> {
    if (this.screenSize) return this.screenSize;
    const size = (await this.connection.screenSize().catch(() => null)) ?? {
      width: 1920,
      height: 1080,
    };
    this.screenSize = size;
    return size;
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  async tap(x: number, y: number, duration?: number): Promise<void> {
    if (duration && duration >= 0.5) {
      await this.input.longPress(x, y);
    } else {
      await this.input.tap(x, y);
    }
  }

  async longPress(x: number, y: number): Promise<void> {
    await this.input.longPress(x, y);
  }

  async swipe(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    durationMs: number
  ): Promise<void> {
    await this.input.swipe(startX, startY, endX, endY, durationMs);
  }

  async pressButton(button: VegaButton): Promise<void> {
    await this.input.pressButton(button);
  }

  async back(): Promise<void> {
    await this.input.pressButton('back');
  }

  async inputText(text: string): Promise<void> {
    await this.input.inputText(text);
  }

  async eraseAllText(charactersToErase = 50): Promise<void> {
    await this.input.eraseText(charactersToErase);
  }

  // ── Inspection ───────────────────────────────────────────────────────────────

  /** Returns uiautomator-style XML (consumed by the Android element resolver). */
  async viewHierarchy(): Promise<string> {
    const xml = await this.automation.getPageSource();
    return parseVegaPageSource(xml);
  }

  async screenshot(_opts: { fullPage?: boolean } = {}): Promise<Buffer> {
    return this.automation.getScreenshot();
  }

  // ── App lifecycle ────────────────────────────────────────────────────────────

  async launchApp(appId: string, _args?: Record<string, string>): Promise<void> {
    // Cold launch: terminate first so a singleton app restarts from initial state.
    await this.cli.terminateApp(appId);
    // The toolkit reads the enable flag at launch, so set it before (re)launching.
    await this.connection.ensureToolkitEnabled();
    await this.cli.launchApp(appId);
  }

  async terminateApp(appId: string): Promise<void> {
    await this.cli.terminateApp(appId);
  }

  async stopApp(appId: string): Promise<void> {
    await this.cli.terminateApp(appId);
  }

  async installApp(vpkgPath: string): Promise<void> {
    await this.cli.installApp(vpkgPath);
  }

  async listInstalledApps(): Promise<string[]> {
    return this.cli.listInstalledApps();
  }

  async getForegroundApp(): Promise<string> {
    // The toolkit page source names the foreground (non-launcher) app.
    const xml = await this.automation.getPageSource();
    const match = /<app[^>]*\bappName="([^"]+)"/.exec(xml);
    if (!match) throw new Error('Could not determine foreground app');
    return match[1];
  }

  // ── Unsupported on vega (gated with clear errors) ────────────────────────────

  async clearAppState(_appId: string): Promise<void> {
    throw UNSUPPORTED('clear-state');
  }

  async clearKeychain(): Promise<void> {
    // Not applicable on Vega — no-op.
  }

  async uninstallApp(_appId: string): Promise<void> {
    throw UNSUPPORTED('uninstall-app');
  }

  async openLink(_url: string): Promise<void> {
    throw UNSUPPORTED('open-link');
  }

  async setLocation(_latitude: number, _longitude: number): Promise<void> {
    throw UNSUPPORTED('set-location');
  }

  async setOrientation(_orientation: string): Promise<void> {
    // No-op: Vega/Fire TV is landscape-only.
  }

  async setPermissions(_appId: string, _permissions: Record<string, string>): Promise<void> {
    // No runtime-permission grant primitive on Vega in v1 — no-op.
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
