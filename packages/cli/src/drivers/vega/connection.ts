/**
 * On-device operations for a single Vega target, all routed through {@link VegaCli}.
 *
 * The automation toolkit that serves the view hierarchy (device port 8383) only
 * attaches when the flag file exists *at app launch*, so {@link ensureToolkitEnabled}
 * must be called before launching the app under test.
 */
import { VegaCli } from './cli.js';
import { log } from '../../verbose.js';

const TOOLKIT_ENABLE_FLAG = '/tmp/automation-toolkit.enable';
const SCREEN_SIZE_RE = /(\d+)\s*x\s*(\d+)/;

export class VegaDeviceConnection {
  constructor(
    readonly serial: string,
    readonly cli: VegaCli = new VegaCli(serial)
  ) {}

  shell(command: string): Promise<string> {
    return this.cli.shell(command);
  }

  copyFrom(remotePath: string, localPath: string): Promise<void> {
    return this.cli.copyFrom(remotePath, localPath);
  }

  /** Idempotently create the toolkit enable flag (read at app launch). */
  async ensureToolkitEnabled(): Promise<void> {
    try {
      await this.shell(`touch ${TOOLKIT_ENABLE_FLAG}`);
    } catch (err) {
      log(`Failed to enable Vega automation toolkit flag: ${String(err)}`);
    }
  }

  /**
   * Device screen size via `inputd-cli get_screen_size`. This is also the
   * developer-mode gate: with dev mode off the on-device shell service is down
   * and no "<W> x <H>" prints.
   */
  async screenSize(): Promise<{ width: number; height: number } | null> {
    const out = (await this.shell('inputd-cli get_screen_size')).trim();
    const match = SCREEN_SIZE_RE.exec(out);
    if (!match) return null;
    return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
  }
}
