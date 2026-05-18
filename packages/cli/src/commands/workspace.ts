export const HELP = `  workspace info                       Print detected project type, bundle IDs, devices, Metro port`;

import fs from 'fs';
import path from 'path';
import { printError, printData, OutputOptions } from '../output.js';
import { discoverBootedDevices } from './list-devices.js';
import { discoverMetroPortForDevice } from '../drivers/log-sources/metro-discovery.js';

interface WorkspaceInfo {
  projectRoot: string;
  projectType: 'rn' | 'expo' | 'ios' | 'android' | 'web' | 'mixed' | 'unknown';
  reactNativeVersion: string | null;
  bundleIds: {
    ios: string | null;
    android: string | null;
  };
  bundleNames: {
    ios: string | null;
    android: string | null;
  };
  hasIosDir: boolean;
  hasAndroidDir: boolean;
  hasPlaywrightConfig: boolean;
  configuredDevices: Array<{ id: string; name: string; platform: string }>;
  metroPort: number | null;
  currentSession: string;
}

function findProjectRoot(start: string): string {
  let cur = path.resolve(start);
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(cur, 'package.json'))) return cur;
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return start;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function detectIosBundleId(projectRoot: string): { id: string | null; name: string | null } {
  const iosDir = path.join(projectRoot, 'ios');
  if (!fs.existsSync(iosDir)) return { id: null, name: null };
  // Look for the first .xcodeproj/project.pbxproj and grep PRODUCT_BUNDLE_IDENTIFIER.
  try {
    const entries = fs.readdirSync(iosDir);
    const xcodeproj = entries.find((e) => e.endsWith('.xcodeproj'));
    if (!xcodeproj) return { id: null, name: null };
    const pbx = path.join(iosDir, xcodeproj, 'project.pbxproj');
    if (!fs.existsSync(pbx)) return { id: null, name: xcodeproj.replace('.xcodeproj', '') };
    const text = fs.readFileSync(pbx, 'utf-8');
    const m = text.match(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"?([A-Za-z0-9._-]+)"?\s*;/);
    return {
      id: m ? m[1] : null,
      name: xcodeproj.replace('.xcodeproj', ''),
    };
  } catch {
    return { id: null, name: null };
  }
}

function detectAndroidBundleId(projectRoot: string): { id: string | null; name: string | null } {
  const candidates = [
    path.join(projectRoot, 'android', 'app', 'build.gradle'),
    path.join(projectRoot, 'android', 'app', 'build.gradle.kts'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const text = fs.readFileSync(file, 'utf-8');
      const idMatch = text.match(/applicationId\s+["']([A-Za-z0-9._-]+)["']/);
      if (idMatch) {
        return { id: idMatch[1], name: idMatch[1].split('.').pop() ?? null };
      }
    } catch {
      // try next
    }
  }
  return { id: null, name: null };
}

export async function workspaceInfo(opts: OutputOptions = {}): Promise<number> {
  const projectRoot = findProjectRoot(process.cwd());
  const pkgPath = path.join(projectRoot, 'package.json');
  const pkg = fs.existsSync(pkgPath) ? readJson(pkgPath) : null;

  const deps = {
    ...((pkg?.dependencies as Record<string, string> | undefined) ?? {}),
    ...((pkg?.devDependencies as Record<string, string> | undefined) ?? {}),
  };

  const rnVersion = deps['react-native'] ?? null;
  const expoVersion = deps['expo'] ?? null;
  const hasIosDir = fs.existsSync(path.join(projectRoot, 'ios'));
  const hasAndroidDir = fs.existsSync(path.join(projectRoot, 'android'));
  const hasPlaywright =
    fs.existsSync(path.join(projectRoot, 'playwright.config.ts')) ||
    fs.existsSync(path.join(projectRoot, 'playwright.config.js')) ||
    fs.existsSync(path.join(projectRoot, 'playwright.config.mjs'));

  let projectType: WorkspaceInfo['projectType'] = 'unknown';
  if (expoVersion) projectType = 'expo';
  else if (rnVersion) projectType = 'rn';
  else if (hasIosDir && hasAndroidDir) projectType = 'mixed';
  else if (hasIosDir) projectType = 'ios';
  else if (hasAndroidDir) projectType = 'android';
  else if (hasPlaywright) projectType = 'web';

  const ios = detectIosBundleId(projectRoot);
  const android = detectAndroidBundleId(projectRoot);

  const devices = await discoverBootedDevices().catch(() => []);
  let metroPort: number | null = null;
  for (const d of devices) {
    if (d.platform !== 'ios' && d.platform !== 'tvos' && d.platform !== 'android') continue;
    const port = await discoverMetroPortForDevice(d.platform, d.id).catch(() => null);
    if (port) {
      metroPort = port;
      break;
    }
  }

  const info: WorkspaceInfo = {
    projectRoot,
    projectType,
    reactNativeVersion: rnVersion,
    bundleIds: { ios: ios.id, android: android.id },
    bundleNames: { ios: ios.name, android: android.name },
    hasIosDir,
    hasAndroidDir,
    hasPlaywrightConfig: hasPlaywright,
    configuredDevices: devices.map((d) => ({ id: d.id, name: d.name, platform: d.platform })),
    metroPort,
    currentSession: process.env.CONDUCTOR_DEVICE ?? 'default',
  };

  if (opts.json) {
    printData(info, opts);
  } else {
    const lines = [
      `projectRoot:        ${info.projectRoot}`,
      `projectType:        ${info.projectType}`,
      `reactNativeVersion: ${info.reactNativeVersion ?? '(none)'}`,
      `iOS bundle id:      ${info.bundleIds.ios ?? '(none)'}`,
      `Android bundle id:  ${info.bundleIds.android ?? '(none)'}`,
      `ios/ dir:           ${info.hasIosDir}`,
      `android/ dir:       ${info.hasAndroidDir}`,
      `playwright config:  ${info.hasPlaywrightConfig}`,
      `metroPort:          ${info.metroPort ?? '(not running)'}`,
      `booted devices:     ${info.configuredDevices.length}`,
      ...info.configuredDevices.map((d) => `  - ${d.id}  ${d.name} (${d.platform})`),
    ];
    console.log(lines.join('\n'));
  }
  return 0;
}

export async function workspaceCmd(sub: string, opts: OutputOptions = {}): Promise<number> {
  if (sub === 'info' || sub === '') return workspaceInfo(opts);
  printError(`Unknown workspace subcommand: ${sub}`, opts);
  return 1;
}
