/**
 * Thin wrapper over Amazon's Vega developer CLI. Vega is not Android, so we drive
 * it through the SDK's own binary (`vega`/`kepler`/`vda`) rather than adb — this is
 * the only supported channel and keeps the same path working for physical Fire TVs.
 *
 * Command surface (verified against the Vega SDK via Maestro's reference driver):
 *  - `vega device list` prints one `<selector> : <profile> - <arch> - <os> - <host>`
 *    line per device; the `-d` selector is the first field (e.g. `VirtualDevice`).
 *  - on-device commands run via `vega device run-cmd -d <sel> -c '<cmd>'` (there is
 *    no `shell -c`; plain `shell` is interactive).
 *  - `-d` is a per-subcommand option, so it follows the subcommand name.
 */
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { log } from '../../verbose.js';

/** A device reported by `vega device list`. */
export interface VegaDevice {
  serial: string;
  description: string;
  isVirtual: boolean;
}

export interface VegaCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function commandSucceeded(r: VegaCommandResult): boolean {
  return r.exitCode === 0;
}

export function commandOutput(r: VegaCommandResult): string {
  return `${r.stdout}\n${r.stderr}`.trim();
}

let _resolvedBinary: string | null = null;

export class VegaCli {
  private readonly binary: string;

  constructor(
    private readonly serial?: string,
    binary?: string
  ) {
    this.binary = binary ?? VegaCli.resolveBinary();
  }

  /** Run a raw CLI invocation and capture output. */
  exec(args: string[], timeoutSeconds = 120): Promise<VegaCommandResult> {
    log(`vega cli: ${this.binary} ${args.join(' ')}`);
    return new Promise((resolve) => {
      const proc = spawn(this.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
      }, timeoutSeconds * 1000);
      proc.stdout.on('data', (c: Buffer) => {
        stdout += c.toString();
      });
      proc.stderr.on('data', (c: Buffer) => {
        stderr += c.toString();
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({ exitCode: 127, stdout: '', stderr: err.message });
      });
    });
  }

  /** Build `device <subcommand> [-d serial] <rest…>` — `-d` follows the subcommand. */
  private deviceArgs(subcommand: string, ...rest: string[]): string[] {
    const selector = this.serial ? ['-d', this.serial] : [];
    return ['device', subcommand, ...selector, ...rest];
  }

  private deviceExec(
    subcommand: string,
    rest: string[] = [],
    timeoutSeconds = 120
  ): Promise<VegaCommandResult> {
    return this.exec(this.deviceArgs(subcommand, ...rest), timeoutSeconds);
  }

  async listDevices(): Promise<VegaDevice[]> {
    const result = await this.exec(['device', 'list']);
    if (!commandSucceeded(result)) {
      log(`\`vega device list\` failed: ${commandOutput(result)}`);
      return [];
    }
    return VegaCli.parseDeviceList(result.stdout);
  }

  /** Run a shell command on the device and return its stdout (via `run-cmd -c`). */
  async shell(command: string): Promise<string> {
    const result = await this.deviceExec('run-cmd', ['-c', command]);
    if (!commandSucceeded(result)) {
      throw new Error(`Vega run-cmd failed: ${commandOutput(result)}`);
    }
    return result.stdout;
  }

  /** Copy a device file to the host via `copy-from` (a file transfer, no stdout limit). */
  async copyFrom(remotePath: string, localPath: string): Promise<void> {
    const result = await this.deviceExec('copy-from', ['-s', remotePath, '-o', localPath]);
    if (!commandSucceeded(result)) {
      throw new Error(`Failed to copy ${remotePath} from device: ${commandOutput(result)}`);
    }
  }

  async launchApp(appId: string): Promise<void> {
    const result = await this.deviceExec('launch-app', ['-a', appId]);
    if (!commandSucceeded(result)) {
      throw new Error(`Failed to launch ${appId}: ${commandOutput(result)}`);
    }
  }

  async terminateApp(appId: string): Promise<void> {
    const result = await this.deviceExec('terminate-app', ['-a', appId]);
    if (!commandSucceeded(result)) {
      log(`Failed to terminate ${appId}: ${commandOutput(result)}`);
    }
  }

  async installApp(vpkgPath: string): Promise<void> {
    const result = await this.deviceExec('install-app', ['-p', vpkgPath], 300);
    if (!commandSucceeded(result)) {
      throw new Error(`Failed to install ${vpkgPath}: ${commandOutput(result)}`);
    }
  }

  async listInstalledApps(): Promise<string[]> {
    const result = await this.deviceExec('installed-apps');
    if (!commandSucceeded(result)) return [];
    return result.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l.includes('.') && !l.includes(' '));
  }

  /** Start streaming device logs with stdout/stderr piped; caller owns the process. */
  startLogStream(): ChildProcess {
    return spawn(this.binary, this.deviceArgs('start-log-stream'), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  /**
   * Boot a Vega Virtual Device via `vega virtual-device start [<name>]`, detached
   * like the Android emulator — the process runs the VVD in the background and the
   * caller polls {@link listDevices} for readiness. Returns the spawned process.
   */
  spawnVirtualDeviceStart(name?: string): ChildProcess {
    const args = ['virtual-device', 'start', ...(name ? [name] : [])];
    const proc = spawn(this.binary, args, { detached: true, stdio: 'ignore' });
    proc.unref();
    return proc;
  }

  // Device lines look like: `VirtualDevice : tv - aarch64 - OS - amazon-<hostname>`.
  // The `-d` selector is the first field (before " : "), not the trailing hostname.
  static parseDeviceList(output: string): VegaDevice[] {
    return output
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes(' : '))
      .map((line) => {
        const serial = line.slice(0, line.indexOf(' : ')).trim();
        if (!serial) return null;
        const isVirtual =
          /^virtualdevice$/i.test(serial) || /^simulator$/i.test(serial) || /virtual/i.test(line);
        return { serial, description: line, isVirtual };
      })
      .filter((d): d is VegaDevice => d !== null);
  }

  /** Resolve the Vega CLI binary: env override → PATH probe → ~/vega/bin → `vega`. */
  static resolveBinary(): string {
    if (_resolvedBinary) return _resolvedBinary;
    const envOverride = process.env.CONDUCTOR_VEGA_CLI;
    if (envOverride && envOverride.trim()) {
      _resolvedBinary = envOverride.trim();
      return _resolvedBinary;
    }
    const candidates = ['vega', 'kepler', 'vda'];
    for (const candidate of candidates) {
      if (isOnPath(candidate)) {
        _resolvedBinary = candidate;
        return candidate;
      }
    }
    const binDir = path.join(os.homedir(), 'vega', 'bin');
    for (const candidate of candidates) {
      const full = path.join(binDir, candidate);
      if (fs.existsSync(full)) {
        _resolvedBinary = full;
        return full;
      }
    }
    // Fall back to `vega`; the first invocation surfaces a clear "command not found".
    _resolvedBinary = 'vega';
    return _resolvedBinary;
  }
}

function isOnPath(command: string): boolean {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, command), fs.constants.X_OK);
      return true;
    } catch {
      /* not here */
    }
  }
  return false;
}
