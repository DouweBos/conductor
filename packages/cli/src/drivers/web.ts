/**
 * HTTP client for the Conductor web browser driver.
 * The driver runs inside the daemon process at http://127.0.0.1:4075 (or custom port).
 *
 * Protocol: plain HTTP REST with JSON bodies — mirrors the iOS XCTest driver pattern.
 * The daemon-side web-server.ts wraps Playwright and exposes these endpoints.
 */
import http from 'http';

export interface WebElement {
  role: string;
  name: string;
  ref: string;
  bounds?: { x: number; y: number; width: number; height: number };
  enabled: boolean;
  focused: boolean;
  checked?: boolean;
  selected?: boolean;
  children?: WebElement[];
}

export interface WebViewHierarchy {
  url: string;
  title: string;
  elements: WebElement[];
  ariaSnapshot: string;
}

export interface WebDeviceInfo {
  widthPixels: number;
  heightPixels: number;
  browserName: string;
  url: string;
}

export class WebDriver {
  constructor(
    private readonly port = 4075,
    private readonly host = '127.0.0.1',
    readonly deviceId?: string
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
        req.destroy(new Error(`Web driver request timed out: ${method} ${path}`));
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
        `Web driver ${path} failed (HTTP ${status}): ${data.toString('utf-8').slice(0, 200)}`
      );
    }
  }

  private async get<T>(path: string): Promise<T> {
    const { status, data } = await this.request('GET', `/${path}`);
    if (status < 200 || status >= 300) {
      throw new Error(
        `Web driver GET ${path} failed (HTTP ${status}): ${data.toString('utf-8').slice(0, 200)}`
      );
    }
    return JSON.parse(data.toString('utf-8')) as T;
  }

  async isAlive(): Promise<boolean> {
    try {
      const { status } = await this.request('GET', '/status');
      return status >= 200 && status < 300;
    } catch {
      return false;
    }
  }

  async deviceInfo(): Promise<WebDeviceInfo> {
    return this.get<WebDeviceInfo>('deviceInfo');
  }

  async tap(x: number, y: number, duration?: number): Promise<void> {
    await this.post('tap', { x, y, ...(duration !== undefined ? { duration } : {}) });
  }

  async swipe(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    duration: number
  ): Promise<void> {
    await this.post('swipe', { startX, startY, endX, endY, duration });
  }

  async inputText(text: string): Promise<void> {
    await this.post('inputText', { text });
  }

  async pressKey(key: string): Promise<void> {
    await this.post('pressKey', { key });
  }

  async launchApp(url: string): Promise<void> {
    await this.post('launchApp', { url });
  }

  async terminateApp(): Promise<void> {
    await this.post('terminateApp', {});
  }

  async clearAppState(): Promise<void> {
    await this.post('clearAppState', {});
  }

  async openLink(url: string): Promise<void> {
    await this.post('navigate', { url });
  }

  async navigate(url: string): Promise<void> {
    await this.post('navigate', { url });
  }

  async goBack(): Promise<void> {
    await this.post('goBack', {});
  }

  async goForward(): Promise<void> {
    await this.post('goForward', {});
  }

  async reload(): Promise<void> {
    await this.post('reload', {});
  }

  async clearCookies(): Promise<void> {
    await this.post('clearCookies', {});
  }

  async clearStorage(): Promise<void> {
    await this.post('clearStorage', {});
  }

  async clearKeychain(): Promise<void> {
    // Web equivalent: clear cookies
    await this.clearCookies();
  }

  async viewHierarchy(): Promise<WebViewHierarchy> {
    return this.get<WebViewHierarchy>('viewHierarchy');
  }

  async screenshot(): Promise<Buffer> {
    const { status, data } = await this.request('GET', '/screenshot');
    if (status < 200 || status >= 300) {
      throw new Error(`Web driver screenshot failed (HTTP ${status})`);
    }
    return data;
  }

  async isScreenStatic(): Promise<boolean> {
    const result = await this.get<{ isScreenStatic: boolean }>('isScreenStatic');
    return result.isScreenStatic;
  }

  async runningApp(): Promise<string> {
    const result = await this.get<{ runningAppBundleId: string }>('runningApp');
    return result.runningAppBundleId;
  }

  async memory(): Promise<{
    metrics: Record<string, number>;
    pageMemory: {
      usedJSHeapSize: number;
      totalJSHeapSize: number;
      jsHeapSizeLimit: number;
    } | null;
    url: string;
  }> {
    return this.get('memory');
  }

  async eraseAllText(count = 50): Promise<void> {
    await this.post('eraseText', { count });
  }

  // ── Stub methods for mobile-only features ──────────────────────────────────
  // These throw clear errors rather than silently no-op so the user knows
  // the command isn't applicable to web.

  async setLocation(_latitude: number, _longitude: number): Promise<void> {
    throw new Error('setLocation is not supported on web');
  }

  async setOrientation(_orientation: string): Promise<void> {
    throw new Error('setOrientation is not supported on web');
  }

  async setPermissions(_appId: string, _permissions: Record<string, string>): Promise<void> {
    throw new Error('setPermissions is not supported on web');
  }

  async addMedia(_filePath: string): Promise<void> {
    throw new Error('addMedia is not supported on web');
  }

  async setAirplaneMode(_enabled: boolean): Promise<void> {
    throw new Error('setAirplaneMode is not supported on web');
  }

  async getAirplaneMode(): Promise<boolean> {
    throw new Error('getAirplaneMode is not supported on web');
  }

  async startRecording(_outputPath: string): Promise<void> {
    throw new Error('startRecording is not supported on web');
  }

  async stopRecording(): Promise<void> {
    throw new Error('stopRecording is not supported on web');
  }

  async uninstallApp(_appId: string): Promise<void> {
    throw new Error('uninstallApp is not supported on web');
  }
}
