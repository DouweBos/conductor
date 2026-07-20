/**
 * Talks to the on-device automation toolkit (the accessibility server Amazon's
 * Appium Vega driver uses), which serves JSON-RPC on device TCP port 8383.
 *
 * Vega is not adb, so there is no host-side `adb forward`. Instead we run `curl`
 * on the device (`vega … run-cmd`), writing the JSON-RPC response to a device file
 * with `curl -o` and pulling it to the host with `copy-from`. Routing through a
 * file (rather than the command's stdout) is required: `run-cmd` truncates large
 * stdout — a full-screen screenshot PNG and a deep page-source tree both exceed it.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { VegaDeviceConnection } from './connection.js';

const TOOLKIT_PORT = 8383;

export class VegaToolkitUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VegaToolkitUnavailableError';
  }
}

export class VegaAutomationClient {
  constructor(private readonly connection: VegaDeviceConnection) {}

  /** Current screen's page-source XML. */
  async getPageSource(): Promise<string> {
    const result = await this.call('getPageSource');
    return typeof result === 'string' ? result : JSON.stringify(result);
  }

  /** Current screen as PNG bytes (base64 in the RPC result). */
  async getScreenshot(): Promise<Buffer> {
    const result = await this.call('takeScreenshot');
    if (typeof result !== 'string') {
      throw new VegaToolkitUnavailableError('takeScreenshot returned no image data');
    }
    return Buffer.from(result, 'base64');
  }

  /** POST a parameterless JSON-RPC [method] to the toolkit and return its `result`. */
  private async call(method: string): Promise<unknown> {
    const devicePath = `/tmp/conductor-vega-${method}.json`;
    const payload = `{"jsonrpc":"2.0","id":1,"method":"${method}","params":{}}`;
    await this.connection.shell(
      `curl -s -X POST -H 'Content-Type: application/json' -d '${payload}' ` +
        `-o ${devicePath} http://127.0.0.1:${TOOLKIT_PORT}/jsonrpc`
    );

    const hostFile = path.join(
      os.tmpdir(),
      `conductor-vega-${method}-${process.pid}-${TOOLKIT_PORT}.json`
    );
    try {
      await this.connection.copyFrom(devicePath, hostFile);
      const raw = await fs.readFile(hostFile, 'utf-8').catch(() => '');
      if (!raw) {
        throw new VegaToolkitUnavailableError(
          `Empty response from the Vega automation toolkit (method=${method}). The toolkit ` +
            `attaches at app launch after the enable flag is set — relaunch the app under test.`
        );
      }
      let node: { error?: unknown; result?: unknown };
      try {
        node = JSON.parse(raw) as { error?: unknown; result?: unknown };
      } catch {
        throw new VegaToolkitUnavailableError(`Malformed toolkit response for ${method}`);
      }
      if (node.error !== undefined && node.error !== null) {
        throw new VegaToolkitUnavailableError(
          `Toolkit error for ${method}: ${JSON.stringify(node.error)}`
        );
      }
      if (node.result === undefined) {
        throw new VegaToolkitUnavailableError(`Toolkit response for ${method} had no result`);
      }
      return node.result;
    } finally {
      await fs.rm(hostFile, { force: true }).catch(() => {});
    }
  }
}
