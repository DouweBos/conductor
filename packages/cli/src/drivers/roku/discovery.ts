/**
 * Discovers Roku devices on the local network. Two best-effort methods:
 *  1. `CONDUCTOR_ROKU_HOST` — a manually pinned device IP/hostname (always checked).
 *  2. SSDP multicast (`M-SEARCH` with `ST: roku:ecp`) — opt-in via
 *     `CONDUCTOR_ROKU_DISCOVERY`, because the scan multicasts on the LAN and adds
 *     ~1s to every device listing.
 */
import dgram from 'dgram';
import net from 'net';
import { log } from '../../verbose.js';
import { RokuEcpClient, DEFAULT_ECP_PORT } from './ecp-client.js';

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SSDP_TIMEOUT_MS = 1000;
const PROBE_TIMEOUT_MS = 500;

export interface DiscoveredRokuDevice {
  host: string;
  modelName: string;
  friendlyName: string;
  serialNumber: string;
  softwareVersion: string;
}

/** The dev-mode password used for screenshots, from the environment. */
export function rokuPassword(): string {
  return process.env.CONDUCTOR_ROKU_PASSWORD ?? '';
}

function discoveryEnabled(): boolean {
  const v = (process.env.CONDUCTOR_ROKU_DISCOVERY ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** All Roku devices reachable right now: the pinned env-var host plus any SSDP hits. */
export async function discoverRokuDevices(): Promise<DiscoveredRokuDevice[]> {
  const hosts = new Set<string>();

  const pinned = process.env.CONDUCTOR_ROKU_HOST?.trim();
  if (pinned) hosts.add(pinned);

  if (discoveryEnabled()) {
    for (const host of await ssdpScan()) hosts.add(host);
  }

  const described = await Promise.all([...hosts].map((host) => describe(host)));
  return described.filter((d): d is DiscoveredRokuDevice => d !== null);
}

/** Resolve a host into a described device, or null if it isn't reachable. */
export async function describe(host: string): Promise<DiscoveredRokuDevice | null> {
  if (!(await isPortOpen(host, DEFAULT_ECP_PORT))) {
    log(`roku: device at ${host} is not reachable on port ${DEFAULT_ECP_PORT}`);
    return null;
  }
  const info = await new RokuEcpClient(host).getDeviceInfo();
  return {
    host,
    modelName: info?.modelName ?? 'Roku Device',
    friendlyName: info?.friendlyName || host,
    serialNumber: info?.serialNumber ?? '',
    softwareVersion: info?.softwareVersion ?? '',
  };
}

/** Quick TCP probe so an offline pinned host fails in ~500ms, not a full HTTP timeout. */
export function isPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/** SSDP M-SEARCH for `roku:ecp` targets; resolves to the responding hosts. */
function ssdpScan(): Promise<string[]> {
  const request = Buffer.from(
    [
      'M-SEARCH * HTTP/1.1',
      `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
      'MAN: "ssdp:discover"',
      'ST: roku:ecp',
      'MX: 1',
      '',
      '',
    ].join('\r\n')
  );

  return new Promise((resolve) => {
    const hosts = new Set<string>();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve([...hosts]);
    };

    const timer = setTimeout(finish, SSDP_TIMEOUT_MS);

    socket.on('message', (msg) => {
      const host = parseSsdpLocation(msg.toString('utf-8'));
      if (host) hosts.add(host);
    });
    socket.on('error', (err) => {
      log(`roku: SSDP scan failed: ${err.message}`);
      finish();
    });
    socket.bind(() => {
      socket.send(request, SSDP_PORT, SSDP_ADDRESS, (err) => {
        if (err) {
          log(`roku: SSDP send failed: ${err.message}`);
          finish();
        }
      });
    });
  });
}

/** Extract the device host from an SSDP response's `LOCATION: http://<ip>:8060/` header. */
export function parseSsdpLocation(response: string): string | null {
  const line = response.split(/\r?\n/).find((l) => /^location:/i.test(l));
  if (!line) return null;
  try {
    return new URL(line.slice(line.indexOf(':') + 1).trim()).hostname || null;
  } catch {
    return null;
  }
}
