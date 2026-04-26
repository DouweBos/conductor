/**
 * Direct gRPC + ADB client for the Conductor Android driver.
 *
 * Protocol:
 *   - gRPC plaintext on localhost:3763 (ADB-forwarded) for: tap, inputText, eraseAllText,
 *     screenshot, viewHierarchy, launchApp, deviceInfo
 *   - ADB shell for: back, swipe/scroll, pressKey, stopApp (not in gRPC proto)
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { resolveAndroidTool } from '../android/sdk.js';

// __dirname is available in CommonJS — points to dist/drivers/
const PROTO_PATH = path.join(__dirname, '../../proto/conductor_android.proto');

let _packageDef: protoLoader.PackageDefinition | null = null;
function loadPackageDef(): protoLoader.PackageDefinition {
  if (!_packageDef) {
    _packageDef = protoLoader.loadSync(PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
  }
  return _packageDef;
}

export interface AndroidDeviceInfo {
  widthPixels: number;
  heightPixels: number;
}

export class AndroidDriver {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null;
  private _recordingProcess: ChildProcess | null = null;
  private _recordingOutputPath = '';

  constructor(
    private readonly deviceId: string,
    private readonly port = 3763
  ) {}

  async connect(): Promise<void> {
    const packageDef = loadPackageDef();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proto = grpc.loadPackageDefinition(packageDef) as any;
    const ConductorDriver = proto.conductor_android.ConductorDriver;
    this.client = new ConductorDriver(`localhost:${this.port}`, grpc.credentials.createInsecure(), {
      'grpc.keepalive_time_ms': 120000,
      'grpc.keepalive_timeout_ms': 20000,
    });
  }

  close(): void {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
  }

  private call<T>(method: string, req: unknown, timeoutMs = 30000): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.client) {
        reject(new Error('AndroidDriver: not connected'));
        return;
      }
      const deadline = new Date(Date.now() + timeoutMs);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.client as any)[method](req, { deadline }, (err: grpc.ServiceError | null, resp: T) => {
        if (err) reject(err);
        else resolve(resp);
      });
    });
  }

  async isAlive(): Promise<boolean> {
    try {
      await this.call<{ widthPixels: number; heightPixels: number }>('deviceInfo', {}, 5000);
      return true;
    } catch {
      return false;
    }
  }

  async deviceInfo(): Promise<AndroidDeviceInfo> {
    const resp = await this.call<{ widthPixels: number; heightPixels: number }>('deviceInfo', {});
    return { widthPixels: resp.widthPixels, heightPixels: resp.heightPixels };
  }

  async tap(x: number, y: number): Promise<void> {
    await this.call('tap', { x: Math.round(x), y: Math.round(y) });
  }

  async inputText(text: string): Promise<void> {
    await this.call('inputText', { text });
  }

  async eraseAllText(charactersToErase = 50): Promise<void> {
    await this.call('eraseAllText', { charactersToErase });
  }

  async launchApp(packageName: string, args?: Record<string, string>): Promise<void> {
    const arguments_: { key: string; value: string; type: string }[] = [];
    if (args) {
      for (const [key, value] of Object.entries(args)) {
        arguments_.push({ key, value, type: 'string' });
      }
    }
    await this.call('launchApp', { packageName, arguments: arguments_ });
  }

  async viewHierarchy(): Promise<string> {
    const resp = await this.call<{ hierarchy: string }>('viewHierarchy', {});
    return resp.hierarchy;
  }

  async screenshot(): Promise<Buffer> {
    const resp = await this.call<{ bytes: Buffer | Uint8Array }>('screenshot', {});
    return Buffer.from(resp.bytes);
  }

  // ── ADB-shell operations (not in gRPC proto) ─────────────────────────────

  private adb(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(resolveAndroidTool('adb'), ['-s', this.deviceId, ...args], {
        stdio: 'ignore',
      });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`adb ${args.join(' ')} failed with exit code ${code}`));
      });
      proc.on('error', reject);
    });
  }

  async back(): Promise<void> {
    await this.adb(['shell', 'input', 'keyevent', '4']);
  }

  async stopApp(packageName: string): Promise<void> {
    await this.adb(['shell', 'am', 'force-stop', packageName]);
  }

  async swipe(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    durationMs: number
  ): Promise<void> {
    await this.adb([
      'shell',
      'input',
      'swipe',
      String(Math.round(startX)),
      String(Math.round(startY)),
      String(Math.round(endX)),
      String(Math.round(endY)),
      String(Math.round(durationMs)),
    ]);
  }

  /** Press a key by Android keyevent code. */
  async pressKeyEvent(keycode: number): Promise<void> {
    await this.adb(['shell', 'input', 'keyevent', String(keycode)]);
  }

  private adbOutput(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(resolveAndroidTool('adb'), ['-s', this.deviceId, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`adb ${args.join(' ')} failed with exit code ${code}`));
      });
      proc.on('error', reject);
    });
  }

  async getForegroundApp(): Promise<string> {
    const output = await this.adbOutput(['shell', 'dumpsys', 'activity', 'activities']);
    const match = output.match(
      /mResumedActivity.*?([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+)\//
    );
    if (!match) throw new Error('Could not determine foreground app');
    return match[1];
  }

  async clearAppState(packageName: string): Promise<void> {
    await this.adb(['shell', 'pm', 'clear', packageName]);
  }

  async uninstallApp(packageName: string): Promise<void> {
    await this.adb(['shell', 'am', 'force-stop', packageName]).catch(() => {});
    await this.adb(['uninstall', packageName]);
  }

  async clearKeychain(): Promise<void> {
    // No-op on Android — keychain is an iOS concept
  }

  async openLink(url: string): Promise<void> {
    await this.adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url]);
  }

  async setLocation(latitude: number, longitude: number): Promise<void> {
    await this.call('setLocation', { latitude, longitude });
  }

  async setOrientation(orientation: string): Promise<void> {
    const rotationMap: Record<string, string> = {
      PORTRAIT: '0',
      LANDSCAPE: '1',
      PORTRAIT_REVERSE: '2',
      LANDSCAPE_REVERSE: '3',
    };
    const rotation = rotationMap[orientation.toUpperCase()] ?? '0';
    // Disable auto-rotation first, then set the rotation value
    await this.adb(['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0']);
    await this.adb(['shell', 'settings', 'put', 'system', 'user_rotation', rotation]);
  }

  async setPermissions(appId: string, permissions: Record<string, string>): Promise<void> {
    const PERMISSION_MAP: Record<string, string[]> = {
      camera: ['android.permission.CAMERA'],
      microphone: ['android.permission.RECORD_AUDIO'],
      location: [
        'android.permission.ACCESS_FINE_LOCATION',
        'android.permission.ACCESS_COARSE_LOCATION',
      ],
      storage: [
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
      ],
      contacts: ['android.permission.READ_CONTACTS', 'android.permission.WRITE_CONTACTS'],
      calendar: ['android.permission.READ_CALENDAR', 'android.permission.WRITE_CALENDAR'],
      phone: ['android.permission.CALL_PHONE', 'android.permission.READ_PHONE_STATE'],
      sms: ['android.permission.SEND_SMS', 'android.permission.RECEIVE_SMS'],
      notifications: [], // Not manageable via pm grant on Android
    };

    const toProcess: Array<{ perm: string; value: string }> = [];

    if ('all' in permissions) {
      const value = permissions['all'];
      if (value !== 'unset') {
        for (const perms of Object.values(PERMISSION_MAP)) {
          for (const perm of perms) toProcess.push({ perm, value });
        }
      }
    } else {
      for (const [name, value] of Object.entries(permissions)) {
        for (const perm of PERMISSION_MAP[name.toLowerCase()] ?? []) {
          toProcess.push({ perm, value });
        }
      }
    }

    for (const { perm, value } of toProcess) {
      const action =
        value === 'allow' || value === 'always' || value === 'whenInUse' ? 'grant' : 'revoke';
      await this.adb(['shell', 'pm', action, appId, perm]).catch(() => {
        /* ignore if permission not declared */
      });
    }
  }

  async addMedia(filePath: string): Promise<void> {
    if (!this.client) throw new Error('AndroidDriver: not connected');
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath).slice(1);
    const name = path.basename(filePath, path.extname(filePath));
    const CHUNK_SIZE = 256 * 1024;

    await new Promise<void>((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const call = (this.client as any).addMedia((err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
      let offset = 0;
      const writeNext = () => {
        if (offset >= data.length) {
          call.end();
          return;
        }
        const chunk = data.slice(offset, offset + CHUNK_SIZE);
        offset += chunk.length;
        call.write({ payload: { data: chunk }, media_name: name, media_ext: ext });
        writeNext();
      };
      writeNext();
    });
  }

  async setAirplaneMode(enabled: boolean): Promise<void> {
    const state = enabled ? '1' : '0';
    await this.adb(['shell', 'settings', 'put', 'global', 'airplane_mode_on', state]);
    await this.adb([
      'shell',
      'am',
      'broadcast',
      '-a',
      'android.intent.action.AIRPLANE_MODE',
      '--ez',
      'state',
      enabled ? 'true' : 'false',
    ]);
  }

  async getAirplaneMode(): Promise<boolean> {
    const output = await this.adbOutput(['shell', 'settings', 'get', 'global', 'airplane_mode_on']);
    return output.trim() === '1';
  }

  async startRecording(outputPath: string): Promise<void> {
    if (this._recordingProcess) await this.stopRecording();
    this._recordingOutputPath = outputPath;
    this._recordingProcess = spawn(
      resolveAndroidTool('adb'),
      ['-s', this.deviceId, 'shell', 'screenrecord', '/sdcard/conductor_recording.mp4'],
      { stdio: 'ignore' }
    );
  }

  async stopRecording(): Promise<void> {
    if (this._recordingProcess) {
      this._recordingProcess.kill('SIGINT');
      await new Promise((r) => setTimeout(r, 1500)); // wait for file to flush
      this._recordingProcess = null;
      if (this._recordingOutputPath) {
        await this.adb([
          'pull',
          '/sdcard/conductor_recording.mp4',
          this._recordingOutputPath,
        ]).catch(() => {});
        await this.adb(['shell', 'rm', '-f', '/sdcard/conductor_recording.mp4']).catch(() => {});
        this._recordingOutputPath = '';
      }
    }
  }
}
