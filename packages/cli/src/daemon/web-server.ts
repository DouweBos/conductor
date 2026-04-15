/**
 * Daemon-embedded HTTP server wrapping Playwright for web browser control.
 *
 * Runs inside the daemon process (spawned by daemon/server.ts) and exposes
 * REST endpoints that the CLI's WebDriver client calls — mirroring the iOS
 * XCTest HTTP server pattern.
 *
 * Browser lifecycle, ARIA snapshot parsing, and bounding-box resolution all
 * happen here so the CLI remains a thin HTTP client.
 */
import http from 'http';
import url from 'url';
import { chromium, firefox, webkit, Browser, BrowserContext, Page } from 'playwright-core';

// ── Console log buffer ──────────────────────────────────────────────────────

interface ConsoleLogEntry {
  timestamp: string;
  level: string;
  message: string;
  stackTrace: string | null;
  source: 'console';
}

const MAX_CONSOLE_BUFFER = 1000;
const _consoleBuffer: ConsoleLogEntry[] = [];

function mapPlaywrightLevel(type: string): ConsoleLogEntry['level'] {
  switch (type) {
    case 'warning':
      return 'warning';
    case 'error':
      return 'error';
    case 'info':
      return 'info';
    case 'debug':
      return 'debug';
    case 'trace':
      return 'verbose';
    default:
      return 'log';
  }
}

function pushConsoleEntry(entry: ConsoleLogEntry): void {
  _consoleBuffer.push(entry);
  if (_consoleBuffer.length > MAX_CONSOLE_BUFFER) {
    _consoleBuffer.splice(0, _consoleBuffer.length - MAX_CONSOLE_BUFFER);
  }
}

function attachConsoleListeners(page: Page): void {
  page.on('console', (msg) => {
    const text = msg.text();
    const loc = msg.location();
    let stackTrace: string | null = null;
    if (loc.url && loc.lineNumber !== undefined) {
      stackTrace = `  at ${loc.url}:${loc.lineNumber + 1}:${(loc.columnNumber ?? 0) + 1}`;
    }
    pushConsoleEntry({
      timestamp: new Date().toISOString(),
      level: mapPlaywrightLevel(msg.type()),
      message: text,
      stackTrace,
      source: 'console',
    });
  });

  page.on('pageerror', (err) => {
    pushConsoleEntry({
      timestamp: new Date().toISOString(),
      level: 'error',
      message: err.message,
      stackTrace: err.stack ?? null,
      source: 'console',
    });
  });
}

// ── Types ────────────────────────────────────────────────────────────────────

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

// ── ARIA snapshot parser ─────────────────────────────────────────────────────

/**
 * Parse Playwright's ariaSnapshot() YAML output into structured WebElement[].
 *
 * Format example:
 *   - heading "My App" [level=1]
 *   - navigation:
 *     - link "Home" [ref=e1]
 *     - link "About" [ref=e2]
 *   - main:
 *     - textbox "Search" [ref=e3]
 *     - button "Submit" [ref=e4] [disabled]
 */
export function parseAriaSnapshot(yaml: string): WebElement[] {
  const lines = yaml.split('\n');
  const root: WebElement[] = [];
  const stack: { indent: number; children: WebElement[] }[] = [{ indent: -1, children: root }];

  for (const line of lines) {
    if (!line.trim() || !line.trim().startsWith('-')) continue;

    const indent = line.search(/\S/);
    const content = line.trim().replace(/^-\s*/, '');

    const el = parseAriaLine(content);
    if (!el) continue;

    // Find the right parent based on indentation
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1];
    parent.children.push(el);

    // If this element could have children (ends with ':'), push onto stack
    if (content.endsWith(':') || el.children) {
      if (!el.children) el.children = [];
      stack.push({ indent, children: el.children });
    }
  }

  return root;
}

/** Bracket tokens from one aria snapshot text line, e.g. `[active] [ref=e3]`. */
function parseBracketAttrs(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /\[(\w[\w-]*)(?:=([^\]]*))?\]/g;
  let m;
  while ((m = attrRe.exec(text)) !== null) {
    attrs[m[1]] = m[2] ?? 'true';
  }
  return attrs;
}

/** `[active]` / `[focused]` (Playwright); `[active=false]` is not focused. */
function attrsIndicateFocus(attrs: Record<string, string>): boolean {
  const truthy = (key: string): boolean => {
    const v = attrs[key];
    return v !== undefined && v !== 'false';
  };
  return truthy('focused') || truthy('active');
}

function parseAriaLine(content: string): WebElement | null {
  // Check if this is a container line like "navigation:" or "main:"
  const containerMatch = content.match(/^(\w[\w-]*)\s*:$/);
  if (containerMatch) {
    return {
      role: containerMatch[1],
      name: '',
      ref: '',
      enabled: true,
      focused: false,
      children: [],
    };
  }

  // Parse: role "name" [attr1] [attr2=val] [ref=eN]
  // Also handles: role "name":  (container with name)
  const isContainer = content.endsWith(':');
  const line = isContainer ? content.slice(0, -1).trim() : content;

  const roleMatch = line.match(/^(\w[\w-]*)/);
  if (!roleMatch) return null;
  const role = roleMatch[1];

  // Extract quoted name
  const nameMatch = line.match(/"([^"]*)"/);
  const name = nameMatch ? nameMatch[1] : '';

  const attrs = parseBracketAttrs(line);

  const el: WebElement = {
    role,
    name,
    ref: attrs['ref'] ?? '',
    enabled: attrs['disabled'] === undefined,
    // Playwright AI snapshots use [active] for the focused element; older output used [focused].
    focused: attrsIndicateFocus(attrs),
    checked:
      attrs['checked'] !== undefined ? true : attrs['unchecked'] !== undefined ? false : undefined,
    selected: attrs['selected'] !== undefined ? true : undefined,
    ...(isContainer ? { children: [] } : {}),
  };

  return el;
}

// ── Bounding box resolution ──────────────────────────────────────────────────

/**
 * Resolve bounding boxes for elements that carry an aria-snapshot `[ref=e…]`.
 * Playwright exposes these as `aria-ref=<ref>` (see ariaSnapshotFrameRef in page.js).
 */
async function resolveBoundingBoxes(page: Page, elements: WebElement[]): Promise<void> {
  const queue: WebElement[] = [...elements];
  while (queue.length > 0) {
    const el = queue.shift()!;
    if (el.ref) {
      try {
        const locator = page.locator(`aria-ref=${el.ref}`);
        const box = await locator.boundingBox({ timeout: 750 });
        if (box && box.width > 0 && box.height > 0) {
          el.bounds = { x: box.x, y: box.y, width: box.width, height: box.height };
        }
      } catch {
        // Element not visible or locator failed — skip
      }
    }
    if (el.children) {
      queue.push(...el.children);
    }
  }
}

/**
 * Last-resort bounds for nodes still missing boxes: role + accessible name via getByRole.
 */
async function resolveBoundingBoxesByRole(page: Page, elements: WebElement[]): Promise<void> {
  const queue: WebElement[] = [...elements];
  while (queue.length > 0) {
    const el = queue.shift()!;
    if (el.children) queue.push(...el.children);
    if (el.bounds || !el.name) continue;
    try {
      const loc = page.getByRole(el.role as Parameters<Page['getByRole']>[0], {
        name: el.name,
        exact: true,
      });
      const box = await loc.first().boundingBox({ timeout: 600 });
      if (box && box.width > 0 && box.height > 0) {
        el.bounds = { x: box.x, y: box.y, width: box.width, height: box.height };
      }
    } catch {
      // Unknown role or no match
    }
  }
}

/**
 * Alternative: resolve bounding boxes by using the Playwright accessibility
 * snapshot and matching refs to the ARIA snapshot elements. This gives us
 * all bounding boxes in a single call rather than per-element.
 */
async function resolveBoundingBoxesBatch(page: Page, elements: WebElement[]): Promise<void> {
  // Use page.evaluate to get all elements with their bounding rects in one shot
  const refMap = new Map<string, WebElement>();
  flattenRefs(elements, refMap);

  if (refMap.size === 0) return;

  // Get the Playwright accessibility snapshot which includes name/role but not bounds.
  // Then use evaluate to get bounding boxes for visible interactive elements.
  try {
    const rects = (await page.evaluate(`(() => {
      const results = {};
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node = walker.currentNode;
      const seen = new Set();
      while (node) {
        const el = node;
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const name =
            el.getAttribute('aria-label') ||
            el.getAttribute('alt') ||
            el.getAttribute('title') ||
            el.getAttribute('placeholder') ||
            (el.textContent || '').trim().slice(0, 100);
          const role =
            el.getAttribute('role') || el.tagName.toLowerCase();
          const key = role + ':' + name;
          if (name && !seen.has(key)) {
            seen.add(key);
            results[key] = {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
          }
        }
        node = walker.nextNode();
      }
      return results;
    })()`)) as Record<string, { x: number; y: number; width: number; height: number }>;

    // Match rects to our parsed elements by name+role
    for (const [, el] of refMap) {
      const key = `${el.role}:${el.name}`;
      if (rects[key]) {
        el.bounds = rects[key];
      }
    }

    // Second pass: match by name only for elements that didn't get bounds
    for (const [, el] of refMap) {
      if (el.bounds) continue;
      for (const [key, rect] of Object.entries(rects)) {
        if (key.endsWith(`:${el.name}`) && el.name) {
          el.bounds = rect;
          break;
        }
      }
    }
  } catch {
    // Fallback: skip bounding boxes if evaluate fails
  }
}

function flattenRefs(elements: WebElement[], map: Map<string, WebElement>): void {
  for (const el of elements) {
    if (el.ref) map.set(el.ref, el);
    if (el.children) flattenRefs(el.children, map);
  }
}

function clearFocusedFlags(elements: WebElement[]): void {
  for (const el of elements) {
    el.focused = false;
    if (el.children) clearFocusedFlags(el.children);
  }
}

function stampRefFocused(elements: WebElement[], ref: string): boolean {
  for (const el of elements) {
    if (el.ref === ref) {
      el.focused = true;
      return true;
    }
    if (el.children && stampRefFocused(el.children, ref)) return true;
  }
  return false;
}

/**
 * Apply `[active]` / `[focused]` from the same YAML string returned as `ariaSnapshot`, so focus state
 * cannot diverge from the snapshot (e.g. stale daemon build or parser edge cases).
 */
function applyFocusFromAriaSnapshotYaml(yaml: string, elements: WebElement[]): void {
  for (const raw of yaml.split('\n')) {
    if (!raw.trim().startsWith('-')) continue;
    const content = raw.trim().replace(/^-\s*/, '');
    const attrs = parseBracketAttrs(content);
    if (!attrsIndicateFocus(attrs)) continue;
    const ref = attrs['ref'];
    if (!ref) continue;
    stampRefFocused(elements, ref);
  }
}

function treeHasFocused(elements: WebElement[]): boolean {
  for (const el of elements) {
    if (el.focused) return true;
    if (el.children && treeHasFocused(el.children)) return true;
  }
  return false;
}

/**
 * When the ARIA snapshot omits `[active]` (e.g. page/window not foreground, or focus not exposed in the
 * a11y snapshot), align focus with `document.activeElement` by matching Playwright `aria-ref` nodes.
 */
async function stampFocusFromDocumentActiveElement(
  page: Page,
  elements: WebElement[]
): Promise<void> {
  if (treeHasFocused(elements)) return;

  const refMap = new Map<string, WebElement>();
  flattenRefs(elements, refMap);
  if (refMap.size === 0) return;

  const activeHandle = await page.evaluateHandle(`(() => document.activeElement)()`);
  try {
    const activeEl = activeHandle.asElement();
    if (!activeEl) return;

    for (const [ref, el] of refMap) {
      try {
        const hit = await page
          .locator(`aria-ref=${ref}`)
          .first()
          .evaluate((node, active) => active !== null && node === active, activeEl);
        if (hit) {
          el.focused = true;
          return;
        }
      } catch {
        // Locator may not resolve for this ref
      }
    }
  } finally {
    await activeHandle.dispose();
  }

  // Last resort: overlap activeElement's client rect with parsed bounds (e.g. ref missing).
  type ActiveRect = { x: number; y: number; width: number; height: number };
  const activeRect = (await page.evaluate(`(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`)) as ActiveRect | null;

  if (!activeRect) return;

  const acx = activeRect.x + activeRect.width / 2;
  const acy = activeRect.y + activeRect.height / 2;
  const rectPick = { best: null as WebElement | null, bestScore: -1 };

  const consider = (el: WebElement): void => {
    if (!el.bounds) return;
    const b = el.bounds;
    const x1 = Math.max(activeRect.x, b.x);
    const y1 = Math.max(activeRect.y, b.y);
    const x2 = Math.min(activeRect.x + activeRect.width, b.x + b.width);
    const y2 = Math.min(activeRect.y + activeRect.height, b.y + b.height);
    const iw = Math.max(0, x2 - x1);
    const ih = Math.max(0, y2 - y1);
    const inter = iw * ih;
    const a1 = activeRect.width * activeRect.height;
    const a2 = b.width * b.height;
    const union = a1 + a2 - inter;
    const iou = union > 0 ? inter / union : 0;
    const centerInside = acx >= b.x && acx <= b.x + b.width && acy >= b.y && acy <= b.y + b.height;
    const score = centerInside ? iou + 1 : iou;
    if (score > rectPick.bestScore) {
      rectPick.bestScore = score;
      rectPick.best = el;
    }
  };

  const walk = (els: WebElement[]): void => {
    for (const el of els) {
      consider(el);
      if (el.children) walk(el.children);
    }
  };
  walk(elements);

  if (rectPick.best !== null && rectPick.bestScore > 0.15) {
    rectPick.best.focused = true;
  }
}

// ── Web server ───────────────────────────────────────────────────────────────

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

let _browser: Browser | null = null;
let _context: BrowserContext | null = null;
let _page: Page | null = null;
let _server: http.Server | null = null;

/**
 * True when connected to an external browser via CDP (e.g. Stagehand's
 * embedded webview). In this mode we must NOT close the browser on shutdown
 * — we only disconnect.
 */
let _cdpMode = false;

export async function startWebServer(
  port: number,
  browserName: 'chromium' | 'firefox' | 'webkit' = 'chromium',
  dlog: (msg: string) => void = () => {},
  cdpUrl?: string
): Promise<void> {
  if (cdpUrl) {
    // ── CDP mode: attach to an existing browser (e.g. Electron webview) ───
    dlog(`Connecting to existing browser via CDP: ${cdpUrl}`);
    _browser = await chromium.connectOverCDP(cdpUrl);
    _cdpMode = true;

    // Use the first existing context and page. The host app (e.g. Stagehand)
    // already created them — we just take a handle.
    const contexts = _browser.contexts();
    if (contexts.length === 0) {
      throw new Error('No browser contexts found via CDP — is the webview loaded?');
    }

    // Find the context with a real page (not about:blank, not the host app).
    for (const ctx of contexts) {
      const pages = ctx.pages();
      const candidate = pages.find(
        (p) => p.url() !== 'about:blank' && !p.url().startsWith('file://')
      );
      if (candidate) {
        _context = ctx;
        _page = candidate;
        break;
      }
    }

    // Fallback: just use the first context's first page.
    if (!_page) {
      _context = contexts[0];
      const pages = _context.pages();
      _page = pages[0] ?? (await _context.newPage());
    }

    attachConsoleListeners(_page);
    dlog(`CDP connected — page: ${_page.url()}`);
  } else {
    // ── Standalone mode: launch a fresh browser ───────────────────────────
    const browserType =
      browserName === 'firefox' ? firefox : browserName === 'webkit' ? webkit : chromium;

    dlog(`Launching ${browserName} browser...`);
    _browser = await browserType.launch({
      headless: false,
      args: browserName === 'chromium' ? ['--disable-search-engine-choice-screen'] : undefined,
    });

    _context = await _browser.newContext({
      viewport: DEFAULT_VIEWPORT,
    });

    _page = await _context.newPage();
    attachConsoleListeners(_page);
    dlog(`Browser ready, page created`);
    _cdpMode = false;
  }

  _server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, dlog);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dlog(`Request error: ${msg}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
    }
  });

  await new Promise<void>((resolve) => {
    _server!.listen(port, '127.0.0.1', () => {
      dlog(`Web server listening on port ${port}`);
      resolve();
    });
  });
}

export async function stopWebServer(): Promise<void> {
  if (_server) {
    _server.close();
    _server = null;
  }

  if (_cdpMode) {
    // CDP mode: we don't own the browser — just release our handles.
    // Do NOT close the page, context, or browser.
    _page = null;
    _context = null;
    if (_browser) {
      // Playwright's connectOverCDP browser supports disconnect() but not close().
      try {
        _browser.close().catch(() => {});
      } catch {
        /* not all CDP browsers support close gracefully */
      }
      _browser = null;
    }
  } else {
    // Standalone mode: we launched the browser, so tear it all down.
    if (_page) {
      await _page.close().catch(() => {});
      _page = null;
    }
    if (_context) {
      await _context.close().catch(() => {});
      _context = null;
    }
    if (_browser) {
      await _browser.close().catch(() => {});
      _browser = null;
    }
  }

  _cdpMode = false;
}

/** Playwright / CDP errors when the tab, context, or session died but our JS refs still exist. */
function isClosedLikeError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /has been closed|Target page|Target closed|Browser has been closed|Context was closed/i.test(
    m
  );
}

/**
 * Drop the context and open a fresh one. Used when newPage/goto fails after the user closed
 * the last tab (Chromium can quit the window) or the CDP target is gone while isConnected stays true.
 *
 * In CDP mode, we can't create new contexts — the host app owns the browser.
 * Instead we try to re-acquire an existing context/page.
 */
async function recreateBrowserContext(dlog?: (msg: string) => void): Promise<void> {
  dlog?.('Web driver: recreating browser context');

  if (!_browser) {
    throw new Error('No page available');
  }
  if (!_browser.isConnected()) {
    throw new Error(
      'Browser has been closed. Restart the web driver (e.g. conductor daemon-start --device web).'
    );
  }

  if (_cdpMode) {
    // In CDP mode, try to re-acquire a page from existing contexts.
    _page = null;
    _context = null;
    const contexts = _browser.contexts();
    for (const ctx of contexts) {
      const pages = ctx.pages();
      const candidate = pages.find((p) => !p.isClosed());
      if (candidate) {
        _context = ctx;
        _page = candidate;
        attachConsoleListeners(_page);
        return;
      }
    }
    throw new Error('No live pages found via CDP — is the webview still open?');
  }

  if (_context) {
    await _context.close().catch(() => {});
    _context = null;
  }
  _page = null;

  _context = await _browser.newContext({
    viewport: DEFAULT_VIEWPORT,
  });
  _page = await _context.newPage();
  attachConsoleListeners(_page);
}

/**
 * Return the active Page, recreating the tab or whole context if handles are stale.
 */
async function getPage(dlog?: (msg: string) => void): Promise<Page> {
  if (!_browser) {
    throw new Error('No page available');
  }
  if (!_browser.isConnected()) {
    throw new Error(
      'Browser has been closed. Restart the web driver (e.g. conductor daemon-start --device web).'
    );
  }

  if (_page && !_page.isClosed()) {
    return _page;
  }

  try {
    if (!_context) {
      await recreateBrowserContext(dlog);
    } else {
      _page = await _context.newPage();
      attachConsoleListeners(_page);
    }
    return _page!;
  } catch (err) {
    if (!isClosedLikeError(err)) throw err;
    await recreateBrowserContext(dlog);
    return _page!;
  }
}

async function gotoWithRecovery(targetUrl: string, dlog?: (msg: string) => void): Promise<void> {
  const opts = { waitUntil: 'domcontentloaded' as const, timeout: 30_000 };
  let p = await getPage(dlog);
  try {
    await p.goto(targetUrl, opts);
  } catch (err) {
    if (!isClosedLikeError(err)) throw err;
    dlog?.(
      `Web driver: goto failed (${err instanceof Error ? err.message : String(err)}), recovering`
    );
    await recreateBrowserContext(dlog);
    p = await getPage(dlog);
    await p.goto(targetUrl, opts);
  }
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function jsonResponse(res: http.ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  dlog: (msg: string) => void
): Promise<void> {
  const rawUrl = req.url ?? '/';
  const parsedUrl = url.parse(rawUrl, true);
  const pathname = parsedUrl.pathname ?? '/';
  const method = req.method ?? 'GET';

  // ── GET endpoints ────────────────────────────────────────────────────────
  if (method === 'GET') {
    switch (pathname) {
      case '/status': {
        jsonResponse(res, { alive: true });
        return;
      }

      case '/deviceInfo': {
        const p = await getPage(dlog);
        const viewport = p.viewportSize() ?? DEFAULT_VIEWPORT;
        jsonResponse(res, {
          widthPixels: viewport.width,
          heightPixels: viewport.height,
          browserName: _browser?.browserType().name() ?? 'unknown',
          url: p.url(),
        });
        return;
      }

      case '/screenshot': {
        const buf = await (await getPage(dlog)).screenshot({ type: 'png' });
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': buf.length,
        });
        res.end(buf);
        return;
      }

      case '/viewHierarchy': {
        const p = await getPage(dlog);
        // `mode: 'ai'` includes `[ref=e…]` on nodes so we can resolve bounds via `aria-ref=`.
        const ariaSnapshot = await p.locator('body').ariaSnapshot({ mode: 'ai' });
        const elements = parseAriaSnapshot(ariaSnapshot);
        await resolveBoundingBoxes(p, elements);
        await resolveBoundingBoxesBatch(p, elements);
        await resolveBoundingBoxesByRole(p, elements);
        clearFocusedFlags(elements);
        applyFocusFromAriaSnapshotYaml(ariaSnapshot, elements);
        await stampFocusFromDocumentActiveElement(p, elements);
        jsonResponse(res, {
          url: p.url(),
          title: await p.title(),
          elements,
          ariaSnapshot,
        });
        return;
      }

      case '/currentUrl': {
        jsonResponse(res, { url: (await getPage(dlog)).url() });
        return;
      }

      case '/title': {
        jsonResponse(res, { title: await (await getPage(dlog)).title() });
        return;
      }

      case '/isScreenStatic': {
        // Compare two consecutive ARIA snapshots to detect page changes
        const p = await getPage(dlog);
        const snap1 = await p.locator('body').ariaSnapshot();
        await new Promise((r) => setTimeout(r, 200));
        const snap2 = await p.locator('body').ariaSnapshot();
        jsonResponse(res, { isScreenStatic: snap1 === snap2 });
        return;
      }

      case '/consoleLogs': {
        const since = (parsedUrl.query['since'] as string) ?? '';
        const entries = since
          ? _consoleBuffer.filter((e) => e.timestamp > since)
          : _consoleBuffer.slice();
        jsonResponse(res, { entries });
        return;
      }

      default: {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
    }
  }

  // ── POST endpoints ───────────────────────────────────────────────────────
  if (method === 'POST') {
    const body = await readBody(req);

    switch (pathname) {
      case '/tap': {
        const x = body['x'] as number;
        const y = body['y'] as number;
        const duration = body['duration'] as number | undefined;
        const p = await getPage(dlog);
        if (duration && duration > 0.5) {
          // Long press: mouse down, wait, mouse up
          await p.mouse.move(x, y);
          await p.mouse.down();
          await new Promise((r) => setTimeout(r, duration * 1000));
          await p.mouse.up();
        } else {
          await p.mouse.click(x, y);
        }
        jsonResponse(res, { ok: true });
        return;
      }

      case '/swipe': {
        const { startX, startY, endX, endY, duration = 500 } = body as Record<string, number>;
        const p = await getPage(dlog);
        const dx = endX - startX;
        const dy = endY - startY;
        // Mouse drag selects text on web; use wheel events for scroll-like moves.
        // Same-point drag is kept for long-press (flow-runner uses swipe at one point + duration).
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
          const steps = Math.max(Math.round(duration / 16), 5); // ~60fps
          await p.mouse.move(startX, startY);
          await p.mouse.down();
          for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            await p.mouse.move(startX + (endX - startX) * t, startY + (endY - startY) * t);
          }
          await p.mouse.up();
        } else {
          const midX = (startX + endX) / 2;
          const midY = (startY + endY) / 2;
          await p.mouse.move(midX, midY);
          // Vector (dx,dy) is finger path; wheel deltas negate that so drag-up → scroll down.
          await p.mouse.wheel(-dx, -dy);
        }
        jsonResponse(res, { ok: true });
        return;
      }

      case '/inputText': {
        const text = body['text'] as string;
        await (await getPage(dlog)).keyboard.type(text);
        jsonResponse(res, { ok: true });
        return;
      }

      case '/pressKey': {
        const key = body['key'] as string;
        await (await getPage(dlog)).keyboard.press(key);
        jsonResponse(res, { ok: true });
        return;
      }

      case '/navigate':
      case '/launchApp': {
        const targetUrl = (body['url'] ?? body['bundleId'] ?? body['appId']) as string;
        if (!targetUrl) {
          jsonResponse(res, { error: 'url is required' }, 400);
          return;
        }
        await gotoWithRecovery(targetUrl, dlog);
        jsonResponse(res, { ok: true });
        return;
      }

      case '/goBack': {
        await (await getPage(dlog))
          .goBack({ waitUntil: 'domcontentloaded', timeout: 10000 })
          .catch(() => {});
        jsonResponse(res, { ok: true });
        return;
      }

      case '/goForward': {
        await (await getPage(dlog))
          .goForward({ waitUntil: 'domcontentloaded', timeout: 10000 })
          .catch(() => {});
        jsonResponse(res, { ok: true });
        return;
      }

      case '/reload': {
        await (await getPage(dlog)).reload({ waitUntil: 'domcontentloaded', timeout: 10000 });
        jsonResponse(res, { ok: true });
        return;
      }

      case '/clearCookies': {
        if (_context) await _context.clearCookies();
        jsonResponse(res, { ok: true });
        return;
      }

      case '/clearStorage': {
        await (
          await getPage(dlog)
        ).evaluate(`(() => {
          try { localStorage.clear(); } catch {}
          try { sessionStorage.clear(); } catch {}
        })()`);
        jsonResponse(res, { ok: true });
        return;
      }

      case '/terminateApp': {
        // Do not `page.close()` here: closing the only Chromium tab often tears down the whole
        // window/CDP target; `goto('about:blank')` resets state without killing the session.
        await gotoWithRecovery('about:blank', dlog);
        jsonResponse(res, { ok: true });
        return;
      }

      case '/clearAppState': {
        if (_context) await _context.clearCookies();
        await (
          await getPage(dlog)
        ).evaluate(`(() => {
          try { localStorage.clear(); } catch {}
          try { sessionStorage.clear(); } catch {}
        })()`);
        jsonResponse(res, { ok: true });
        return;
      }

      case '/runningApp': {
        jsonResponse(res, { runningAppBundleId: (await getPage(dlog)).url() });
        return;
      }

      case '/eraseText': {
        const count = (body['count'] as number) ?? 50;
        const p = await getPage(dlog);
        for (let i = 0; i < count; i++) {
          await p.keyboard.press('Backspace');
        }
        jsonResponse(res, { ok: true });
        return;
      }

      case '/shutdown': {
        jsonResponse(res, { ok: true });
        // Graceful shutdown after response is sent
        setTimeout(() => {
          stopWebServer().then(() => process.exit(0));
        }, 100);
        return;
      }

      default: {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
    }
  }

  res.writeHead(405);
  res.end('Method not allowed');
}
