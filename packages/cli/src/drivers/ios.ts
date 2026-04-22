/**
 * Direct HTTP client for the Conductor iOS XCTest driver.
 * The driver runs inside the simulator at http://127.0.0.1:1075 (or custom port).
 *
 * Protocol: plain HTTP REST with JSON bodies.
 * Endpoints map directly to XCUITest actions — no JVM required.
 */
import http from 'http';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';

export interface AXFrame {
  X: number;
  Y: number;
  Width: number;
  Height: number;
}

export interface AXElement {
  identifier: string;
  frame: AXFrame;
  value?: string;
  title?: string;
  label: string;
  elementType: number;
  enabled: boolean;
  selected: boolean;
  hasFocus: boolean;
  placeholderValue?: string;
  /** Accessibility hint — populated by the driver when available. */
  hint?: string;
  children?: AXElement[];
}

export interface IOSViewHierarchy {
  axElement: AXElement;
  depth: number;
}

export interface IOSDeviceInfo {
  widthPoints: number;
  heightPoints: number;
  widthPixels: number;
  heightPixels: number;
}

export class IOSDriver {
  private _recordingProcess: ChildProcess | null = null;

  constructor(
    private readonly port = 1075,
    private readonly host = '127.0.0.1',
    readonly deviceId?: string,
    readonly platform: 'ios' | 'tvos' = 'ios'
  ) {}

  private request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown
  ): Promise<{ status: number; data: Buffer }> {
    return new Promise((resolve, reject) => {
      const bodyBuf = body !== undefined ? Buffer.from(JSON.stringify(body), 'utf-8') : undefined;
      const options: http.RequestOptions = {
        hostname: this.host,
        port: this.port,
        path,
        method,
        headers: {
          ...(bodyBuf
            ? { 'Content-Type': 'application/json', 'Content-Length': bodyBuf.length }
            : {}),
        },
      };

      const req = http.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks) }));
        res.on('error', reject);
      });

      req.setTimeout(30000, () => {
        req.destroy(new Error(`iOS driver request timed out: ${method} ${path}`));
      });
      req.on('error', reject);

      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  }

  private async post(path: string, body: unknown): Promise<void> {
    const { status, data } = await this.request('POST', `/${path}`, body);
    if (status < 200 || status >= 300) {
      throw new Error(
        `iOS driver ${path} failed (HTTP ${status}): ${data.toString('utf-8').slice(0, 200)}`
      );
    }
  }

  private async get<T>(path: string): Promise<T> {
    const { status, data } = await this.request('GET', `/${path}`);
    if (status < 200 || status >= 300) {
      throw new Error(
        `iOS driver GET ${path} failed (HTTP ${status}): ${data.toString('utf-8').slice(0, 200)}`
      );
    }
    return JSON.parse(data.toString('utf-8')) as T;
  }

  private requireDeviceId(): string {
    if (!this.deviceId) throw new Error('IOSDriver: deviceId is required for this operation');
    return this.deviceId;
  }

  private simctl(args: string[]): Promise<void> {
    const _id = this.requireDeviceId();
    return new Promise((resolve, reject) => {
      const proc = spawn('xcrun', ['simctl', ...args], { stdio: 'ignore' });
      proc.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`xcrun simctl ${args[0]} failed (exit ${code})`))
      );
      proc.on('error', reject);
    });
  }

  private simctlCapture(args: string[]): Promise<string> {
    this.requireDeviceId();
    return new Promise((resolve, reject) => {
      const proc = spawn('xcrun', ['simctl', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      proc.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString();
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        err += chunk.toString();
      });
      proc.on('close', (code) =>
        code === 0
          ? resolve(out.trim())
          : reject(new Error(`xcrun simctl ${args[0]} failed: ${err.trim()}`))
      );
      proc.on('error', reject);
    });
  }

  async isAlive(): Promise<boolean> {
    try {
      const { status } = await this.request('GET', '/status');
      return status >= 200 && status < 300;
    } catch {
      return false;
    }
  }

  async deviceInfo(): Promise<IOSDeviceInfo> {
    return this.get<IOSDeviceInfo>('deviceInfo');
  }

  async tap(x: number, y: number, duration?: number): Promise<void> {
    await this.post('touch', { x, y, ...(duration !== undefined ? { duration } : {}) });
  }

  async swipe(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    duration: number,
    appIds?: string[]
  ): Promise<void> {
    await this.post('swipeV2', {
      startX,
      startY,
      endX,
      endY,
      duration,
      ...(appIds ? { appIds } : {}),
    });
  }

  async inputText(text: string, appIds: string[] = []): Promise<void> {
    await this.post('inputText', { text, appIds });
  }

  async pressKey(key: 'delete' | 'return' | 'enter' | 'tab' | 'space'): Promise<void> {
    await this.post('pressKey', { key });
  }

  async pressButton(
    button: 'home' | 'lock' | 'up' | 'down' | 'left' | 'right' | 'select' | 'menu' | 'playPause'
  ): Promise<void> {
    await this.post('pressButton', { button });
  }

  async launchApp(bundleId: string, args?: Record<string, string>): Promise<void> {
    if (args && Object.keys(args).length > 0) {
      const deviceId = this.requireDeviceId();
      // xctest /launchApp doesn't support launch args — use simctl
      await this.simctl(['terminate', deviceId, bundleId]).catch(() => {});
      const argPairs: string[] = [];
      for (const [key, value] of Object.entries(args)) {
        argPairs.push(`-${key}`, value);
      }
      await this.simctl(['launch', '--terminate-running-process', deviceId, bundleId, ...argPairs]);
    } else {
      await this.post('launchApp', { bundleId });
    }
  }

  async terminateApp(appId: string): Promise<void> {
    await this.post('terminateApp', { appId });
  }

  async clearAppState(bundleId: string): Promise<void> {
    const deviceId = this.requireDeviceId();
    // Terminate first to prevent app from saving state after clear
    await this.simctl(['terminate', deviceId, bundleId]).catch(() => {});
    // Capture the .app bundle path before uninstalling — uninstall deletes the UUID directory
    // so the path is invalid by the time we need to reinstall from it.
    const appPath = await this.simctlCapture(['get_app_container', deviceId, bundleId, 'app']);

    // Copy the .app bundle to a temp dir so it survives the uninstall
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'conductor-clear-state-'));
    const tmpAppPath = path.join(tmpDir, path.basename(appPath));
    try {
      await fs.cp(appPath, tmpAppPath, { recursive: true });
      await this.simctl(['uninstall', deviceId, bundleId]);
      await this.simctl(['install', deviceId, tmpAppPath]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async uninstallApp(bundleId: string): Promise<void> {
    const deviceId = this.requireDeviceId();
    await this.simctl(['terminate', deviceId, bundleId]).catch(() => {});
    await this.simctl(['uninstall', deviceId, bundleId]);
  }

  async clearKeychain(): Promise<void> {
    const deviceId = this.requireDeviceId();
    await this.simctl(['keychain', deviceId, 'reset']);
  }

  async openLink(url: string): Promise<void> {
    const deviceId = this.requireDeviceId();
    await this.simctl(['openurl', deviceId, url]);
  }

  async setLocation(latitude: number, longitude: number): Promise<void> {
    const deviceId = this.requireDeviceId();
    await this.simctl(['location', deviceId, 'set', `${latitude},${longitude}`]);
  }

  async setOrientation(orientation: string): Promise<void> {
    await this.post('setOrientation', { orientation });
  }

  async setPermissions(appId: string, permissions: Record<string, string>): Promise<void> {
    // All iOS permissions the XCTest runner's interruption monitor can handle.
    const IOS_ALL_PERMISSIONS = [
      'notifications',
      'camera',
      'microphone',
      'photos',
      'location',
      'contacts',
      'calendar',
      'reminders',
      'bluetooth',
      'health',
      'motion',
      'speech',
      'tracking',
      'faceId',
      'homeKit',
      'mediaLibrary',
      'siri',
      'localNetwork',
    ];

    // Expand 'all' to every known permission
    const expanded: Record<string, string> = { ...permissions };
    const allValue = expanded['all'];
    if (allValue !== undefined) {
      delete expanded['all'];
      for (const perm of IOS_ALL_PERMISSIONS) {
        if (!(perm in expanded)) {
          expanded[perm] = allValue;
        }
      }
    }

    // ── simctl privacy ────────────────────────────────────────────────────────
    // For simulators: use simctl privacy grant/revoke to pre-approve permissions
    // in TCC so no dialog ever appears. This covers ALL permission types including
    // ATT (tracking), local network, etc. that the XCTest runner can't intercept.
    //
    // simctl service names differ from Maestro key names for some entries.
    const SIMCTL_SERVICE: Record<string, string> = {
      notifications: 'notifications',
      camera: 'camera',
      microphone: 'microphone',
      photos: 'photos',
      location: 'location',
      contacts: 'contacts',
      calendar: 'calendar',
      reminders: 'reminders',
      bluetooth: 'bluetooth',
      motion: 'motion',
      speech: 'speech',
      tracking: 'tracking',
      faceId: 'faceid',
      homeKit: 'homekit',
      mediaLibrary: 'media-library',
      siri: 'siri',
    };

    const deviceId = this.requireDeviceId();

    if (allValue !== undefined) {
      // Best-effort bulk grant/revoke. 'all' covers TCC-managed permissions but
      // NOT ATT (tracking), which needs an explicit individual call below.
      const action = allValue === 'allow' ? 'grant' : 'revoke';
      try {
        await this.simctl(['privacy', deviceId, action, 'all', appId]);
      } catch {
        /* not installed yet */
      }
    }

    // Always grant/revoke each permission individually — some services (e.g. tracking/ATT)
    // are not included in 'grant all' and require an explicit call.
    for (const [perm, value] of Object.entries(expanded)) {
      const service = SIMCTL_SERVICE[perm];
      if (!service) continue;
      const action = value === 'allow' ? 'grant' : 'revoke';
      try {
        await this.simctl(['privacy', deviceId, action, service, appId]);
      } catch {
        /* ignore */
      }
    }

    // Also notify the XCTest runner — its interruption monitor handles the
    // notifications dialog and acts as a fallback for any dialog we missed.
    await this.post('setPermissions', { permissions: expanded });
  }

  async addMedia(filePath: string): Promise<void> {
    const deviceId = this.requireDeviceId();
    await this.simctl(['addmedia', deviceId, filePath]);
  }

  async setAirplaneMode(_enabled: boolean): Promise<void> {
    throw new Error('setAirplaneMode is not supported on iOS simulators');
  }

  async getAirplaneMode(): Promise<boolean> {
    throw new Error('getAirplaneMode is not supported on iOS simulators');
  }

  async startRecording(outputPath: string): Promise<void> {
    const deviceId = this.requireDeviceId();
    if (this._recordingProcess) await this.stopRecording();
    this._recordingProcess = spawn(
      'xcrun',
      ['simctl', 'io', deviceId, 'recordVideo', '--codec', 'hevc', outputPath],
      { stdio: 'ignore' }
    );
  }

  async stopRecording(): Promise<void> {
    if (this._recordingProcess) {
      this._recordingProcess.kill('SIGINT');
      await new Promise((r) => setTimeout(r, 500));
      this._recordingProcess = null;
    }
  }

  async viewHierarchy(
    excludeKeyboardElements = false,
    appIds: string[] = []
  ): Promise<IOSViewHierarchy> {
    const { status, data } = await this.request('POST', '/viewHierarchy', {
      appIds,
      excludeKeyboardElements,
    });
    if (status < 200 || status >= 300) {
      throw new Error(
        `iOS driver viewHierarchy failed (HTTP ${status}): ${data.toString('utf-8').slice(0, 200)}`
      );
    }
    return JSON.parse(data.toString('utf-8')) as IOSViewHierarchy;
  }

  async screenshot(): Promise<Buffer> {
    const { status, data } = await this.request('GET', '/screenshot');
    if (status < 200 || status >= 300) {
      throw new Error(`iOS driver screenshot failed (HTTP ${status})`);
    }
    return data;
  }

  async isScreenStatic(): Promise<boolean> {
    const result = await this.get<{ isScreenStatic: boolean }>('isScreenStatic');
    return result.isScreenStatic;
  }

  async runningApp(appIds: string[]): Promise<string> {
    const { status, data } = await this.request('POST', '/runningApp', { appIds });
    if (status < 200 || status >= 300) {
      throw new Error(
        `iOS driver runningApp failed (HTTP ${status}): ${data.toString('utf-8').slice(0, 200)}`
      );
    }
    const parsed = JSON.parse(data.toString('utf-8')) as { runningAppBundleId?: string };
    const id = parsed.runningAppBundleId;
    if (!id) throw new Error('Could not determine foreground app');
    return id;
  }
}
