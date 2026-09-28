/**
 * Driver for macOS apps on the host Mac.
 *
 * Talks to the same XCUITest HTTP server as iOS/tvOS (built as a macOS UI test
 * runner), so the view hierarchy, selectors and tap/type paths are shared. What
 * differs is everything around it: there is no simulator, so every simctl path
 * in IOSDriver is blocked here and app lifecycle goes through the host instead.
 *
 * Coordinates are window-relative: (0,0) is the top-left of the frontmost app's
 * front window, which is also what screenshots capture.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { IOSDriver } from './ios.js';

/** Fixed device ID for the host Mac — there is only ever one. */
export const MACOS_DEVICE_ID = 'macos';

export type MacModifier = 'command' | 'shift' | 'option' | 'control' | 'function';

export class MacDriver extends IOSDriver {
  constructor(port: number) {
    super(port, '127.0.0.1', MACOS_DEVICE_ID, 'macos', false);
  }

  private unsupportedOnMac(operation: string, alternative?: string): never {
    throw new Error(
      `${operation} is not supported on macOS` + (alternative ? ` — ${alternative}` : '') + '.'
    );
  }

  // Nothing on this driver may reach a simulator: any inherited path that still
  // shells out to simctl fails here with a clear message instead.
  protected override async simctl(args: string[]): Promise<void> {
    this.unsupportedOnMac(`simctl ${args[0]}`);
  }

  protected override async simctlCapture(args: string[]): Promise<string> {
    this.unsupportedOnMac(`simctl ${args[0]}`);
  }

  override async tap(
    x: number,
    y: number,
    duration?: number,
    opts: { modifiers?: MacModifier[]; count?: number } = {}
  ): Promise<void> {
    await this.post('touch', {
      x,
      y,
      ...(duration !== undefined ? { duration } : {}),
      ...(opts.modifiers?.length ? { modifiers: opts.modifiers } : {}),
      ...(opts.count ? { count: opts.count } : {}),
    });
    this.invalidateHierarchyCache();
  }

  /** Which driver answered, and (background driver) its permission state. */
  async status(): Promise<{ mode?: string; accessibility?: boolean; screenRecording?: boolean }> {
    return this.get('status');
  }

  /** Point the driver at the app under test instead of whatever is frontmost. */
  async setTarget(bundleId: string): Promise<void> {
    await this.post('target', { bundleId });
    this.invalidateHierarchyCache();
  }

  async rightClick(x: number, y: number, modifiers: MacModifier[] = []): Promise<void> {
    await this.post('rightClick', { x, y, modifiers });
    this.invalidateHierarchyCache();
  }

  async hover(x: number, y: number): Promise<void> {
    await this.post('hover', { x, y });
    this.invalidateHierarchyCache();
  }

  /** Scroll-wheel at (x, y). Negative deltaY reveals content further down. */
  async scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    await this.post('scroll', { x, y, deltaX, deltaY });
    this.invalidateHierarchyCache();
  }

  /** Press at start, drag to end, release. `swipe` scrolls on macOS; this moves things. */
  async drag(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    duration?: number
  ): Promise<void> {
    await this.post('drag', {
      startX,
      startY,
      endX,
      endY,
      ...(duration !== undefined ? { duration } : {}),
    });
    this.invalidateHierarchyCache();
  }

  /** Click through the menu bar, e.g. ['File', 'Export', 'PDF…']. */
  async menu(path: string[]): Promise<void> {
    await this.post('menu', { path });
    this.invalidateHierarchyCache();
  }

  /** Press a key with modifiers held, e.g. ('s', ['command']) for ⌘S. */
  async pressKeyCombo(key: string, modifiers: MacModifier[] = []): Promise<void> {
    await this.post('pressKey', { key, modifiers });
    this.invalidateHierarchyCache();
  }

  override async launchApp(
    bundleId: string,
    args?: Record<string, string>,
    inject?: { dylibPath: string; inprocPort: number }
  ): Promise<void> {
    if (inject) {
      this.unsupportedOnMac('In-process injection', 'launch without --inject');
    }
    const argPairs: string[] = [];
    for (const [key, value] of Object.entries(args ?? {})) {
      // A key with no value is a bare flag, e.g. Chromium's --force-renderer-accessibility.
      if (value === undefined) argPairs.push(`--${key}`);
      else argPairs.push(`-${key}`, value);
    }
    if (argPairs.length > 0) {
      // Launch arguments only reach a fresh process, so quit any running copy
      // first — and wait, or `open` just reactivates the one still quitting.
      await this.terminateApp(bundleId).catch(() => {});
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && (await isRunning(bundleId))) {
        await new Promise((r) => setTimeout(r, 250));
      }
      await run('open', ['-g', '-b', bundleId, '--args', ...argPairs]);
      await this.setTarget(bundleId);
    } else {
      await this.post('launchApp', { bundleId });
    }
    this.invalidateHierarchyCache();
  }

  override async clearAppState(_bundleId: string): Promise<void> {
    this.unsupportedOnMac(
      'clear-state',
      'Mac apps keep state in the user account; reset it with `defaults delete <bundle-id>` if you mean to'
    );
  }

  override async uninstallApp(_bundleId: string): Promise<void> {
    this.unsupportedOnMac('uninstall-app', 'remove the .app from /Applications yourself');
  }

  override async clearKeychain(): Promise<void> {
    this.unsupportedOnMac('clear-keychain', 'it would wipe your own login keychain');
  }

  override async openLink(url: string): Promise<void> {
    await run('open', [url]);
    this.invalidateHierarchyCache();
  }

  /** The host's real clipboard — there is no separate device pasteboard. */
  override async clipboardRead(): Promise<string> {
    return run('pbpaste', []);
  }

  override async clipboardWrite(text: string): Promise<void> {
    await run('pbcopy', [], text);
  }

  override async setLocation(_latitude: number, _longitude: number): Promise<void> {
    this.unsupportedOnMac('set-location');
  }

  override async setOrientation(_orientation: string): Promise<void> {
    this.unsupportedOnMac('set-orientation');
  }

  override async setPermissions(
    _appId: string,
    _permissions: Record<string, string>
  ): Promise<void> {
    this.unsupportedOnMac(
      'set-permissions',
      'grant access in System Settings ▸ Privacy & Security instead'
    );
  }

  override async addMedia(_filePath: string): Promise<void> {
    this.unsupportedOnMac('add-media');
  }

  override async startRecording(_outputPath: string): Promise<void> {
    this.unsupportedOnMac('Screen recording', 'capture stills with `conductor take-screenshot`');
  }
}

async function isRunning(bundleId: string): Promise<boolean> {
  const out = await run('lsappinfo', ['info', '-only', 'pid', '-app', bundleId]).catch(() => '');
  return /"pid"\s*=\s*\d+/.test(out);
}

function run(cmd: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout?.on('data', (c: Buffer) => {
      out += c.toString();
    });
    proc.stderr?.on('data', (c: Buffer) => {
      err += c.toString();
    });
    proc.on('close', (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`${cmd} failed: ${err.trim() || `exit ${code}`}`))
    );
    proc.on('error', reject);
    proc.stdin?.end(stdin ?? '');
  });
}

const MODIFIER_ALIASES: Record<string, MacModifier> = {
  cmd: 'command',
  command: 'command',
  '⌘': 'command',
  meta: 'command',
  shift: 'shift',
  '⇧': 'shift',
  alt: 'option',
  opt: 'option',
  option: 'option',
  '⌥': 'option',
  ctrl: 'control',
  control: 'control',
  '⌃': 'control',
  fn: 'function',
};

/** Named keys the macOS driver's /pressKey understands, besides single characters. */
const MAC_NAMED_KEYS = new Set([
  'return',
  'enter',
  'tab',
  'space',
  'escape',
  'esc',
  'delete',
  'backspace',
  'forwarddelete',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

/**
 * Parse a shortcut like `cmd+s`, `Cmd+Shift+Z` or `ctrl+tab` into a key and its
 * modifiers. Returns null when any part isn't a known modifier or key.
 */
export function parseMacKeyCombo(combo: string): { key: string; modifiers: MacModifier[] } | null {
  const parts = combo.split('+');
  // A literal plus, as in `cmd++`, leaves an empty final part.
  if (parts.length > 1 && parts[parts.length - 1] === '' && parts[parts.length - 2] === '') {
    parts.splice(-2, 2, '+');
  }
  const base = parts.pop()?.trim();
  if (!base) return null;
  const modifiers: MacModifier[] = [];
  for (const raw of parts) {
    const mod = MODIFIER_ALIASES[raw.trim().toLowerCase()];
    if (!mod) return null;
    if (!modifiers.includes(mod)) modifiers.push(mod);
  }
  const key = base.length === 1 ? base.toLowerCase() : base.toLowerCase().replace(/[\s_-]/g, '');
  if (key.length !== 1 && !MAC_NAMED_KEYS.has(key)) return null;
  return { key, modifiers };
}

/** Parse `cmd,shift` (or `cmd+shift`) into modifiers; null when any name is unknown. */
export function parseMacModifiers(list: string): MacModifier[] | null {
  const modifiers: MacModifier[] = [];
  for (const raw of list.split(/[,+]/)) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    const mod = MODIFIER_ALIASES[name];
    if (!mod) return null;
    if (!modifiers.includes(mod)) modifiers.push(mod);
  }
  return modifiers;
}

const APP_DIRS = [
  '/Applications',
  '/Applications/Utilities',
  '/System/Applications',
  '/System/Applications/Utilities',
  path.join(os.homedir(), 'Applications'),
];

/** Apps in the standard Applications folders, with their bundle IDs from Spotlight. */
export async function listMacApps(): Promise<Array<{ id: string; name: string; path: string }>> {
  const paths = APP_DIRS.flatMap((dir) => {
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.app'))
        .map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  });
  if (paths.length === 0) return [];
  const attr = async (name: string) =>
    (await run('mdls', ['-raw', '-name', name, ...paths])).split('\0');
  const [ids, names] = await Promise.all([
    attr('kMDItemCFBundleIdentifier'),
    attr('kMDItemDisplayName'),
  ]);
  const apps: Array<{ id: string; name: string; path: string }> = [];
  paths.forEach((p, i) => {
    const id = ids[i]?.trim();
    if (!id || id === '(null)') return;
    const name = names[i]?.trim().replace(/\.app$/, '') || path.basename(p, '.app');
    apps.push({ id, name, path: p });
  });
  return apps.sort((a, b) => a.id.localeCompare(b.id));
}

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

/**
 * Install a .app into ~/Applications, replacing any previous copy, and register
 * it with LaunchServices so it can be launched by bundle ID straight away.
 */
export async function installMacApp(appPath: string): Promise<string> {
  const src = path.resolve(appPath);
  if (!src.endsWith('.app') || !fs.existsSync(path.join(src, 'Contents', 'Info.plist'))) {
    throw new Error(`${appPath} is not a macOS .app bundle`);
  }
  const destDir = path.join(os.homedir(), 'Applications');
  const dest = path.join(destDir, path.basename(src));
  if (dest !== src) {
    fs.mkdirSync(destDir, { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    await run('ditto', [src, dest]);
  }
  await run(LSREGISTER, ['-f', dest]).catch(() => {});
  return dest;
}
