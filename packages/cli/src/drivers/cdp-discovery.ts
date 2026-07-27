/**
 * Discovery of externally-launched CDP endpoints (e.g. an Electron app started
 * with `--remote-debugging-port`, which exposes one page target per webview/tile).
 *
 * Unlike the Playwright web driver (which conductor launches itself) these
 * browsers already exist — so "discovery" means finding the DevTools HTTP
 * endpoint. CDP servers don't advertise themselves, so we probe a small range of
 * localhost ports and enumerate each reachable endpoint's page targets via
 * `/json/list`. The same target-fetch is reused by the `web-targets` command.
 */
import http from 'http';
import type { Device } from '../commands/list-devices.js';

/** Default localhost ports scanned for CDP endpoints. Covers Chromium/Electron's
 *  conventional `--remote-debugging-port` values without a wide scan. */
export const DEFAULT_CDP_PORTS = [9222, 9223, 9224, 9225, 9226, 9227, 9228, 9229];

const PROBE_TIMEOUT_MS = 300;

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** Derive the `http://host:port` base from a CDP URL (which may be ws:// or include a path). */
export function httpBase(cdpUrl: string): string {
  const u = new URL(cdpUrl);
  const proto = u.protocol === 'https:' || u.protocol === 'wss:' ? 'https:' : 'http:';
  return `${proto}//${u.host}`;
}

/** GET a CDP DevTools JSON endpoint, parsing the array response. */
function getJson<T>(url: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        if ((res.statusCode ?? 0) >= 300) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as T);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timed out fetching ${url}`)));
    req.on('error', reject);
  });
}

/** Fetch the CDP page targets exposed at `cdpUrl`'s `/json/list`. */
export function fetchCdpTargets(cdpUrl: string, timeoutMs = 5000): Promise<CdpTarget[]> {
  return getJson<CdpTarget[]>(`${httpBase(cdpUrl)}/json/list`, timeoutMs);
}

/**
 * Device-id encoding for a discovered CDP webview: `web:cdp:<port>:<targetId>`.
 * Self-describing so the id alone hydrates the CDP url + target at bind time —
 * a discovered webview is drivable with no `--cdp-*` flags. Localhost is assumed
 * (discovery only scans localhost).
 */
export function formatCdpDeviceId(port: number, targetId: string): string {
  return `web:cdp:${port}:${targetId}`;
}

export interface ParsedCdpDeviceId {
  port: number;
  targetId: string;
  cdpUrl: string;
}

/** Parse a `web:cdp:<port>:<targetId>` device id, or undefined if it isn't one. */
export function parseCdpDeviceId(deviceId: string): ParsedCdpDeviceId | undefined {
  const m = /^web:cdp:(\d+):(.+)$/.exec(deviceId);
  if (!m) return undefined;
  const port = Number(m[1]);
  if (!Number.isInteger(port) || port <= 0) return undefined;
  return { port, targetId: m[2], cdpUrl: `http://127.0.0.1:${port}` };
}

/** Map a reachable endpoint's page targets to discovered `web` devices. */
export function cdpTargetsToDevices(port: number, targets: CdpTarget[]): Device[] {
  return targets
    .filter((t) => t.type === 'page')
    .map((t) => ({
      id: formatCdpDeviceId(port, t.id),
      name: t.title || t.url || t.id,
      platform: 'web',
      status: 'running',
    }));
}

/**
 * Scan localhost CDP ports and return every discovered webview as a device.
 * Probes run in parallel with a short timeout and swallow all errors — an
 * unreachable port simply contributes nothing. Safe to call on the hot device-
 * resolution path.
 */
export async function discoverCdpDevices(ports: number[] = DEFAULT_CDP_PORTS): Promise<Device[]> {
  const results = await Promise.all(
    ports.map(async (port) => {
      try {
        const targets = await fetchCdpTargets(`http://127.0.0.1:${port}`, PROBE_TIMEOUT_MS);
        return cdpTargetsToDevices(port, targets);
      } catch {
        return [] as Device[];
      }
    })
  );
  return results.flat();
}
