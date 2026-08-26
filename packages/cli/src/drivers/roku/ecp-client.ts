/**
 * HTTP client for the Roku External Control Protocol (ECP). All Roku device
 * communication goes through a REST API on device port 8060; screenshots go through
 * the developer web server on port 80 (digest auth with the dev-mode password).
 *
 * Requires the device to be in developer mode with ECP network access set to
 * "Permissive" — recent Roku OS versions return 403 on input commands otherwise.
 */
import crypto from 'crypto';
import { log } from '../../verbose.js';
import { sleep } from '../../utils.js';
import { XmlNode, parseXml, childElement } from '../xml.js';

export const DEFAULT_ECP_PORT = 8060;

const DEV_USERNAME = 'rokudev';
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_BACKOFF_MS = 50;
const SCREENSHOT_FORMATS = ['jpg', 'png'] as const;
const SCREENSHOT_TIMEOUT_MS = 10_000;
const SCREENSHOT_POLL_INTERVAL_MS = 250;

/** `statusCode` is the status the device answered with, or undefined on a transport failure. */
export class RokuEcpError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number
  ) {
    super(message);
    this.name = 'RokuEcpError';
  }
}

export interface RokuActiveApp {
  id: string;
  title: string;
  type: string;
  version: string;
}

export interface RokuDeviceDetails {
  modelName: string;
  modelNumber: string;
  serialNumber: string;
  softwareVersion: string;
  uiResolution: string;
  friendlyName: string;
  widthPixels: number;
  heightPixels: number;
}

export interface RokuEcpClientOptions {
  password?: string;
  ecpPort?: number;
  keypressDelayMs?: number;
  maxRetries?: number;
}

export class RokuEcpClient {
  private readonly password: string;
  private readonly ecpPort: number;
  private readonly keypressDelayMs: number;
  private readonly maxRetries: number;

  /** RFC 2617 `nc` counts requests sent with one nonce, restarting at 1 for a new one. */
  private digestNonce: string | null = null;
  private digestNonceCount = 0;

  constructor(
    readonly host: string,
    opts: RokuEcpClientOptions = {}
  ) {
    this.password = opts.password ?? '';
    this.ecpPort = opts.ecpPort ?? DEFAULT_ECP_PORT;
    this.keypressDelayMs = opts.keypressDelayMs ?? 100;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  private get baseUrl(): string {
    return `http://${this.host}:${this.ecpPort}`;
  }

  // ── Key input ───────────────────────────────────────────────────────────────

  async sendKeypress(key: string): Promise<void> {
    await this.ecpPost(`keypress/${encodePathSegment(key)}`);
    if (this.keypressDelayMs > 0) await sleep(this.keypressDelayMs);
  }

  async sendKeyDown(key: string): Promise<void> {
    await this.ecpPost(`keydown/${encodePathSegment(key)}`);
  }

  async sendKeyUp(key: string): Promise<void> {
    await this.ecpPost(`keyup/${encodePathSegment(key)}`);
  }

  /** Types text character-by-character via ECP `LIT_` keypresses. */
  async sendText(text: string): Promise<void> {
    for (const char of text) {
      await this.ecpPost(`keypress/${encodePathSegment(`LIT_${char}`)}`);
      if (this.keypressDelayMs > 0) await sleep(this.keypressDelayMs);
    }
  }

  // ── App lifecycle ───────────────────────────────────────────────────────────

  /**
   * Launches a channel with the caller's parameters and nothing else — no
   * `RTA_LAUNCH` flag, which asks a roku-test-automation channel *not* to restart
   * (the opposite of the cold launch `launchApp` guarantees) and on any other
   * channel is an unexpected parameter riding along with the flow's deep link.
   */
  async launchChannel(channelId: string, params: Record<string, string> = {}): Promise<void> {
    const query = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    await this.ecpPost(query ? `launch/${channelId}?${query}` : `launch/${channelId}`);
  }

  async getActiveApp(): Promise<RokuActiveApp | null> {
    const root = await this.ecpGetXml('query/active-app');
    const app = root ? childElement(root, 'app') : undefined;
    if (!app) return null;
    return {
      id: app.attrs['id'] ?? '',
      title: app.text.trim(),
      type: app.attrs['type'] ?? '',
      version: app.attrs['version'] ?? '',
    };
  }

  async isActiveApp(channelId: string): Promise<boolean> {
    return (await this.getActiveApp())?.id === channelId;
  }

  // ── Device info ─────────────────────────────────────────────────────────────

  async getDeviceInfo(): Promise<RokuDeviceDetails | null> {
    const root = await this.ecpGetXml('query/device-info');
    if (!root) return null;

    const fields: Record<string, string> = {};
    for (const child of root.children) fields[child.tag] = child.text.trim();

    const uiResolution = fields['ui-resolution'] || '1080p';
    const is1080 = uiResolution.includes('1080');
    return {
      modelName: fields['model-name'] || 'Unknown',
      modelNumber: fields['model-number'] ?? '',
      serialNumber: fields['serial-number'] ?? '',
      softwareVersion: fields['software-version'] ?? '',
      uiResolution,
      friendlyName: fields['friendly-device-name'] || fields['device-name'] || '',
      widthPixels: is1080 ? 1920 : 1280,
      heightPixels: is1080 ? 1080 : 720,
    };
  }

  // ── View hierarchy ──────────────────────────────────────────────────────────

  /** Raw SceneGraph XML from `/query/app-ui`, or null when the query fails. */
  async getAppUIRaw(): Promise<string | null> {
    try {
      const res = await this.executeWithRetry(`${this.baseUrl}/query/app-ui`, { method: 'GET' });
      return await res.text();
    } catch (err) {
      // Queries stay tolerant: callers treat null as "hierarchy unavailable".
      log(`roku ecp: GET query/app-ui failed: ${errMessage(err)}`);
      return null;
    }
  }

  // ── Screenshot ──────────────────────────────────────────────────────────────

  /**
   * Captures a screenshot. Two steps: POST `/plugin_inspect` to generate it, then
   * GET `/pkgs/dev.jpg` (or `.png`) to download it.
   *
   * The dev server acknowledges the generation POST before the capture file is
   * written (observed on Roku OS 14), so the download polls until the file's ETag
   * differs from the pre-generation one; on timeout the current file is used — a
   * re-capture of an unchanged screen can legitimately produce identical bytes.
   */
  async takeScreenshot(): Promise<Buffer> {
    const previousEtags = new Map<string, string | null>();
    for (const format of SCREENSHOT_FORMATS) {
      previousEtags.set(format, await this.screenshotEtag(format));
    }

    await this.generateScreenshot();

    const deadline = Date.now() + SCREENSHOT_TIMEOUT_MS;
    for (;;) {
      const timedOut = Date.now() >= deadline;
      for (const format of SCREENSHOT_FORMATS) {
        // Cache-bust with a timestamp so no intermediary replays an old capture.
        const url = `http://${this.host}/pkgs/dev.${format}?time=${Date.now()}`;
        try {
          const res = await this.digestFetch(url, { method: 'GET' });
          if (!res.ok) continue;
          const etag = res.headers.get('etag');
          const previous = previousEtags.get(format) ?? null;
          const isFresh = previous === null || etag === null || etag !== previous;
          if (isFresh || timedOut) {
            if (!isFresh) {
              log(
                `roku ecp: screenshot ETag unchanged after ${SCREENSHOT_TIMEOUT_MS}ms; using current capture`
              );
            }
            return Buffer.from(await res.arrayBuffer());
          }
        } catch (err) {
          log(`roku ecp: failed to download screenshot as ${format}: ${errMessage(err)}`);
        }
      }

      if (timedOut) break;
      await sleep(SCREENSHOT_POLL_INTERVAL_MS);
    }

    throw new Error(
      `Failed to capture a screenshot from the Roku device at ${this.host}. ` +
        `Screenshots require the developer-mode password (CONDUCTOR_ROKU_PASSWORD).`
    );
  }

  /** ETag of the current capture file, or null if none exists (or the server omits it). */
  private async screenshotEtag(format: string): Promise<string | null> {
    try {
      const res = await this.digestFetch(`http://${this.host}/pkgs/dev.${format}`, {
        method: 'HEAD',
      });
      return res.ok ? res.headers.get('etag') : null;
    } catch {
      return null;
    }
  }

  private async generateScreenshot(): Promise<void> {
    const url = `http://${this.host}/plugin_inspect`;

    // The dev server only runs the form action when the multipart body arrives on an
    // already-authorized request (curl's --digest behavior: an empty-body probe
    // collects the challenge, then the form is sent with Authorization attached up
    // front). Sending the body on the unauthenticated request and retrying returns a
    // 200 whose action silently never ran — so the handshake is explicit here.
    let challenge: string | null = null;
    try {
      const probe = await fetchWithTimeout(url, { method: 'POST', body: '' });
      if (probe.status === 401) challenge = probe.headers.get('www-authenticate');
    } catch (err) {
      throw new Error(
        `Screenshot generation request to the Roku device at ${this.host} failed: ${errMessage(err)}`
      );
    }

    // Two quirks, both verified against Roku OS 14 hardware: the empty `archive`
    // field is required (without it the form handler silently does nothing), and
    // parts must carry ONLY a Content-Disposition header — the server's parser
    // ignores parts with a per-part Content-Length. So the body is built by hand.
    const boundary = `----ConductorRokuFormBoundary${process.hrtime.bigint()}`;
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="mysubmit"\r\n\r\n` +
      `Screenshot\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="archive"\r\n\r\n` +
      `\r\n` +
      `--${boundary}--\r\n`;

    const headers: Record<string, string> = {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    };
    const auth = challenge && this.buildDigestHeader(challenge, 'POST', '/plugin_inspect');
    if (auth) headers['authorization'] = auth;

    let text: string;
    try {
      const res = await fetchWithTimeout(url, { method: 'POST', headers, body });
      if (!res.ok) {
        throw new Error(
          `Screenshot generation failed (HTTP ${res.status}). ` +
            `Check the developer-mode password (CONDUCTOR_ROKU_PASSWORD).`
        );
      }
      text = await res.text();
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Screenshot generation failed')) throw err;
      throw new Error(
        `Screenshot generation request to the Roku device at ${this.host} failed: ${errMessage(err)}`
      );
    }

    // The dev server reports the result inside the returned page; anything else
    // means no fresh capture was written to /pkgs/dev.jpg.
    if (!text.includes('Screenshot ok')) {
      log(`roku ecp: plugin_inspect did not confirm: ${text.replace(/\n/g, ' ').slice(0, 300)}`);
      throw new Error(
        `The Roku device at ${this.host} did not confirm the screenshot ` +
          `(requires a sideloaded dev channel in the foreground).`
      );
    }
  }

  // ── Connectivity ────────────────────────────────────────────────────────────

  async isReachable(): Promise<boolean> {
    try {
      await fetchWithTimeout(`${this.baseUrl}/`, { method: 'GET' });
      return true;
    } catch {
      return false;
    }
  }

  // ── Digest auth ─────────────────────────────────────────────────────────────

  /** Issue a request, answering a 401 digest challenge with a signed retry. */
  private async digestFetch(url: string, init: RequestInit): Promise<Response> {
    const first = await fetchWithTimeout(url, init);
    if (first.status !== 401) return first;

    const challenge = first.headers.get('www-authenticate');
    if (!challenge) return first;
    const auth = this.buildDigestHeader(challenge, init.method ?? 'GET', new URL(url).pathname);
    if (!auth) return first;

    return fetchWithTimeout(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization: auth },
    });
  }

  private nextNonceCount(nonce: string): number {
    if (nonce !== this.digestNonce) {
      this.digestNonce = nonce;
      this.digestNonceCount = 0;
    }
    return ++this.digestNonceCount;
  }

  private buildDigestHeader(challengeHeader: string, method: string, uri: string): string | null {
    if (!/^digest /i.test(challengeHeader)) return null;

    const params = parseDigestChallenge(challengeHeader.replace(/^digest /i, ''));
    const realm = params['realm'];
    const nonce = params['nonce'];
    if (!realm || !nonce) return null;
    const qop = params['qop'];

    const nc = this.nextNonceCount(nonce).toString(16).padStart(8, '0');
    const cnonce = (process.hrtime.bigint() & 0xffffffffn).toString(16).padStart(8, '0');

    const ha1 = md5Hex(`${DEV_USERNAME}:${realm}:${this.password}`);
    const ha2 = md5Hex(`${method}:${uri}`);
    const response = qop
      ? md5Hex(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
      : md5Hex(`${ha1}:${nonce}:${ha2}`);

    let header = `Digest username="${DEV_USERNAME}", realm="${realm}", nonce="${nonce}", uri="${uri}"`;
    if (qop) header += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
    return `${header}, response="${response}"`;
  }

  // ── Internal HTTP helpers ───────────────────────────────────────────────────

  /**
   * Issues a state-changing ECP call (input, launch). Throws on failure: a command
   * that never reached the device must fail the flow rather than let it keep
   * asserting against a screen no keypress ever touched.
   */
  private async ecpPost(path: string): Promise<void> {
    await this.executeWithRetry(`${this.baseUrl}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '',
    });
  }

  private async ecpGetXml(path: string): Promise<XmlNode | null> {
    try {
      const res = await this.executeWithRetry(`${this.baseUrl}/${path}`, { method: 'GET' });
      return parseXml(await res.text());
    } catch (err) {
      log(`roku ecp: GET ${path} failed: ${errMessage(err)}`);
      return null;
    }
  }

  /**
   * Executes a request, retrying transport failures and 5xx responses. The HTTP
   * status survives into the error because it is the detail that matters most —
   * a 403 means ECP access isn't set to Permissive.
   */
  private async executeWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastFailure: RokuEcpError | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      let failure: RokuEcpError;
      try {
        const res = await fetchWithTimeout(url, init);
        if (res.ok) return res;
        failure = new RokuEcpError(
          `ECP request to ${url} failed with HTTP ${res.status}.${hintForStatus(res.status)}`,
          res.status
        );
      } catch (err) {
        failure = new RokuEcpError(`ECP request to ${url} failed: ${errMessage(err)}`);
      }

      lastFailure = failure;
      // 4xx is the device's verdict on this request — a retry re-sends what it
      // already rejected, so report it now instead of after three round trips.
      if (failure.statusCode !== undefined && failure.statusCode < 500) break;

      if (attempt < this.maxRetries) {
        log(`roku ecp: ${failure.message} (attempt ${attempt}/${this.maxRetries}). Retrying.`);
        await sleep(RETRY_BACKOFF_MS);
      }
    }

    throw lastFailure ?? new RokuEcpError(`ECP request to ${url} failed`);
  }
}

// ── Standalone helpers (exported for tests) ───────────────────────────────────

/** Setup advice for the statuses a misconfigured device actually returns. */
export function hintForStatus(status: number): string {
  if (status === 403) {
    return (
      ' The device is refusing ECP commands: set Settings > System > Advanced system ' +
      'settings > Control by mobile apps > Network access to "Permissive".'
    );
  }
  if (status === 401) return ' Check the developer-mode password (CONDUCTOR_ROKU_PASSWORD).';
  return '';
}

/**
 * Percent-encode a URL path segment. `encodeURIComponent` leaves `!'()*` alone and
 * ECP would deliver those literally, so they are escaped too — a space must arrive
 * as `%20`, never `+` (`LIT_+` types a plus, not a space).
 */
export function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export function parseDigestChallenge(header: string): Record<string, string> {
  const params: Record<string, string> = {};
  const re = /(\w+)=(?:"([^"]*)"|([\w/]+))/g;
  let m;
  while ((m = re.exec(header)) !== null) {
    params[m[1]] = m[2] || m[3];
  }
  return params;
}

export function md5Hex(input: string): string {
  return crypto.createHash('md5').update(input).digest('hex');
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}
