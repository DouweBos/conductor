export const HELP_INSTALL_PLUGIN = `  install-plugin [--check]            Register/update the global Claude Code plugin (status only with --check)`;

export const HELP_INSTALL_SKILLS = `  install-skills [--check]            Copy skills into local .claude/skills/ (status only with --check)`;

export const HELP_INSTALL_WEB = `  install-web [--check] [browser]     Install Playwright browser (chromium, firefox, webkit) (status only with --check)`;

import fs from 'fs';
import os from 'os';
import path from 'path';
import { printSuccess, printError, printData } from '../output.js';
import { findPkgRoot } from '../pkg-root.js';
import { ensurePlaywrightBrowser, isPlaywrightBrowserInstalled } from '../drivers/bootstrap.js';

export async function installPluginCli(opts: { json: boolean }, check: boolean): Promise<number> {
  try {
    if (check) {
      return checkPluginInstallStatus(opts);
    }
    const version = installPlugin();
    const pluginCacheDir = path.join(
      os.homedir(),
      '.claude',
      'plugins',
      'cache',
      'conductor',
      'conductor',
      version
    );
    printSuccess(`Conductor plugin installed (v${version}) → ${pluginCacheDir}`, opts);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    printError(`Install failed: ${message}`, opts);
    return 1;
  }
}

function checkPluginInstallStatus(opts: { json: boolean }): number {
  const installedPluginsPath = path.join(
    os.homedir(),
    '.claude',
    'plugins',
    'installed_plugins.json'
  );

  let pluginVersion: string | null = null;
  if (fs.existsSync(installedPluginsPath)) {
    const installed = JSON.parse(fs.readFileSync(installedPluginsPath, 'utf8')) as {
      plugins?: { name: string; version: string }[];
    };
    const plugins = Array.isArray(installed.plugins) ? installed.plugins : [];
    const entry = plugins.find((p) => p.name === 'conductor');
    if (entry) pluginVersion = entry.version;
  }

  if (opts.json) {
    printData(
      { globalPlugin: { installed: pluginVersion !== null, version: pluginVersion } },
      opts
    );
  } else {
    if (pluginVersion) {
      console.log(`Global plugin: installed (v${pluginVersion})`);
    } else {
      console.log('Global plugin: not installed');
      console.log(
        'Run `npm install -g @houwert/conductor` or `conductor install-plugin` to register it.'
      );
    }
  }

  return 0;
}

export async function installSkillsCli(opts: { json: boolean }, check: boolean): Promise<number> {
  try {
    if (check) {
      return checkSkillsInstallStatus(opts);
    }
    installLocalSkills();
    printSuccess('Conductor skills installed → .claude/skills/conductor/', opts);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    printError(`Install failed: ${message}`, opts);
    return 1;
  }
}

export async function installWebCli(
  opts: { json: boolean },
  check: boolean,
  browserArg: string | undefined
): Promise<number> {
  try {
    if (check) {
      return checkWebInstallStatus(opts);
    }
    return installWebBrowser(browserArg, opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    printError(`Install failed: ${message}`, opts);
    return 1;
  }
}

function checkSkillsInstallStatus(opts: { json: boolean }): number {
  const localSkillsPath = path.join(process.cwd(), '.claude', 'skills', 'conductor', 'SKILL.md');
  const hasLocalSkills = fs.existsSync(localSkillsPath);

  if (opts.json) {
    printData({ localSkills: { installed: hasLocalSkills } }, opts);
  } else {
    if (hasLocalSkills) {
      console.log('Local skills: installed → .claude/skills/conductor/');
    } else {
      console.log('Local skills: not installed');
      console.log('Run `conductor install-skills` to copy skills into this project.');
    }
  }

  return 0;
}

function checkWebInstallStatus(opts: { json: boolean }): number {
  const webBrowsers = {
    chromium: isPlaywrightBrowserInstalled('chromium'),
    firefox: isPlaywrightBrowserInstalled('firefox'),
    webkit: isPlaywrightBrowserInstalled('webkit'),
  };

  if (opts.json) {
    printData({ webBrowsers }, opts);
  } else {
    const installedBrowsers = Object.entries(webBrowsers)
      .filter(([, v]) => v)
      .map(([k]) => k);
    if (installedBrowsers.length > 0) {
      console.log(`Web browsers: ${installedBrowsers.join(', ')}`);
    } else {
      console.log('Web browsers: none installed');
      console.log(
        'Run `conductor install-web` to install a Playwright browser (default: chromium).'
      );
    }
  }

  return 0;
}

export function installLocalSkills(): void {
  const pkgRoot = findPkgRoot(__dirname);
  const skillsSrc = path.join(pkgRoot, 'skills', 'conductor');
  if (!fs.existsSync(skillsSrc)) {
    throw new Error(`No skills found at ${skillsSrc}`);
  }
  const skillsDest = path.join(process.cwd(), '.claude', 'skills', 'conductor');
  copyDir(skillsSrc, skillsDest);
}

export function installPlugin(): string {
  const pkgRoot = findPkgRoot(__dirname);

  const pkgJsonPath = path.join(pkgRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { version: string };
  const version = pkg.version;

  const pluginCacheDir = path.join(
    os.homedir(),
    '.claude',
    'plugins',
    'cache',
    'conductor',
    'conductor',
    version
  );
  fs.mkdirSync(pluginCacheDir, { recursive: true });

  const skillsSrc = path.join(pkgRoot, 'skills', 'conductor');
  if (fs.existsSync(skillsSrc)) {
    copyDir(skillsSrc, path.join(pluginCacheDir, 'skills', 'conductor'));
  }

  const pluginJsonSrc = path.join(pkgRoot, '.claude-plugin', 'plugin.json');
  if (fs.existsSync(pluginJsonSrc)) {
    const pluginMetaDir = path.join(pluginCacheDir, '.claude-plugin');
    fs.mkdirSync(pluginMetaDir, { recursive: true });
    fs.copyFileSync(pluginJsonSrc, path.join(pluginMetaDir, 'plugin.json'));
  }

  const installedPluginsPath = path.join(
    os.homedir(),
    '.claude',
    'plugins',
    'installed_plugins.json'
  );
  let installed: { plugins: { name: string; version: string; path: string }[] } = { plugins: [] };
  if (fs.existsSync(installedPluginsPath)) {
    installed = JSON.parse(fs.readFileSync(installedPluginsPath, 'utf8')) as typeof installed;
    if (!Array.isArray(installed.plugins)) {
      installed.plugins = [];
    }
  }

  installed.plugins = installed.plugins.filter((p) => p.name !== 'conductor');
  installed.plugins.push({ name: 'conductor', version, path: pluginCacheDir });
  fs.mkdirSync(path.dirname(installedPluginsPath), { recursive: true });
  fs.writeFileSync(installedPluginsPath, JSON.stringify(installed, null, 2));

  return version;
}

async function installWebBrowser(
  browserArg: string | undefined,
  opts: { json: boolean }
): Promise<number> {
  const validBrowsers = ['chromium', 'firefox', 'webkit'] as const;
  type BrowserName = (typeof validBrowsers)[number];

  let browserName: BrowserName = 'chromium';
  if (browserArg !== undefined && browserArg !== '') {
    if (!validBrowsers.includes(browserArg as BrowserName)) {
      printError(`Unknown browser "${browserArg}". Supported: ${validBrowsers.join(', ')}`, opts);
      return 1;
    }
    browserName = browserArg as BrowserName;
  }

  try {
    await ensurePlaywrightBrowser(browserName, (msg) => {
      if (!opts.json) console.log(msg);
    });
    printSuccess(`Playwright ${browserName} browser installed`, opts);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    printError(msg, opts);
    return 1;
  }
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
