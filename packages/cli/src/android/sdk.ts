/**
 * Android SDK tool resolver.
 *
 * Locates `emulator`, `adb`, `avdmanager`, and `sdkmanager` on disk so conductor
 * works even when the SDK is installed but its bin dirs aren't on PATH (a common
 * setup on macOS where Android Studio installs to ~/Library/Android/sdk and only
 * adb tends to be linked, e.g. via Homebrew).
 *
 * Lookup order for the SDK root:
 *   1. ANDROID_HOME
 *   2. ANDROID_SDK_ROOT
 *   3. ~/Library/Android/sdk         (macOS default)
 *   4. ~/Android/Sdk                 (Linux default)
 *   5. %LOCALAPPDATA%/Android/Sdk    (Windows default)
 *
 * Each tool lives in a conventional subdir (with legacy fallbacks for cmdline tools).
 * If nothing is found on disk, the bare command name is returned so the OS can do a
 * final PATH lookup.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export type AndroidTool = 'emulator' | 'adb' | 'avdmanager' | 'sdkmanager';

const isWindows = process.platform === 'win32';

function exeName(base: string, kind: 'binary' | 'script'): string {
  if (!isWindows) return base;
  return kind === 'script' ? `${base}.bat` : `${base}.exe`;
}

/** Subdirectories (relative to the SDK root) and the executable name for each tool. */
function candidateSubpaths(tool: AndroidTool): string[] {
  switch (tool) {
    case 'emulator':
      return [path.join('emulator', exeName('emulator', 'binary'))];
    case 'adb':
      return [path.join('platform-tools', exeName('adb', 'binary'))];
    case 'avdmanager':
      return [
        path.join('cmdline-tools', 'latest', 'bin', exeName('avdmanager', 'script')),
        path.join('tools', 'bin', exeName('avdmanager', 'script')),
      ];
    case 'sdkmanager':
      return [
        path.join('cmdline-tools', 'latest', 'bin', exeName('sdkmanager', 'script')),
        path.join('tools', 'bin', exeName('sdkmanager', 'script')),
      ];
  }
}

/** Candidate SDK root directories, in priority order. */
function candidateSdkRoots(): string[] {
  const roots: string[] = [];
  const env = process.env;
  if (env.ANDROID_HOME) roots.push(env.ANDROID_HOME);
  if (env.ANDROID_SDK_ROOT) roots.push(env.ANDROID_SDK_ROOT);

  const home = os.homedir();
  if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Android', 'sdk'));
  } else if (process.platform === 'win32') {
    const localAppData = env.LOCALAPPDATA;
    if (localAppData) roots.push(path.join(localAppData, 'Android', 'Sdk'));
  } else {
    roots.push(path.join(home, 'Android', 'Sdk'));
  }

  // De-dupe while preserving order
  return Array.from(new Set(roots));
}

/** First SDK root that actually exists on disk, or undefined. */
export function findAndroidSdkRoot(): string | undefined {
  for (const root of candidateSdkRoots()) {
    try {
      if (fs.existsSync(root) && fs.statSync(root).isDirectory()) return root;
    } catch {
      // ignore
    }
  }
  return undefined;
}

/**
 * Absolute path to the Android SDK tool, or the bare tool name if nothing was found
 * on disk (so PATH lookup can still take a swing at it).
 */
export function resolveAndroidTool(tool: AndroidTool): string {
  const root = findAndroidSdkRoot();
  if (root) {
    for (const sub of candidateSubpaths(tool)) {
      const full = path.join(root, sub);
      if (fs.existsSync(full)) return full;
    }
  }
  return tool;
}

/**
 * Environment overrides to merge into a spawned child's env when shelling out to
 * an Android tool. Sets ANDROID_HOME / ANDROID_SDK_ROOT if (a) we found an SDK
 * root on disk and (b) the parent process didn't already export them. The
 * `emulator` binary in particular sometimes refuses to start without these.
 */
export function androidToolEnv(): NodeJS.ProcessEnv {
  const root = findAndroidSdkRoot();
  if (!root) return {};
  const out: NodeJS.ProcessEnv = {};
  if (!process.env.ANDROID_HOME) out.ANDROID_HOME = root;
  if (!process.env.ANDROID_SDK_ROOT) out.ANDROID_SDK_ROOT = root;
  return out;
}

/** Convenience: env to pass directly as `spawn(..., { env: androidSpawnEnv() })`. */
export function androidSpawnEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...androidToolEnv(), ...(extra ?? {}) };
}

/**
 * Lazily patches `process.env` with ANDROID_HOME / ANDROID_SDK_ROOT (when
 * unset) so any child process that inherits parent env picks them up. Idempotent.
 *
 * Call sites that resolve Android tools should invoke this so the spawned
 * tool — `emulator` in particular — finds the SDK even when ANDROID_HOME isn't
 * exported in the user's shell.
 */
let _envEnsured = false;
export function ensureAndroidEnv(): void {
  if (_envEnsured) return;
  _envEnsured = true;
  const overrides = androidToolEnv();
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined && process.env[k] === undefined) {
      process.env[k] = v;
    }
  }
}
