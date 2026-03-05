import fs from 'fs';
import os from 'os';
import path from 'path';
import { printSuccess, printError } from '../output.js';
import { findPkgRoot } from '../pkg-root.js';

export async function installSkills(opts: { json: boolean }): Promise<number> {
  try {
    installPlugin();
    printSuccess('Conductor Claude Code plugin installed', opts);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    printError(`Plugin install failed: ${message}`, opts);
    return 1;
  }
}

export function installPlugin(): void {
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
  }

  installed.plugins = installed.plugins.filter((p) => p.name !== 'conductor');
  installed.plugins.push({ name: 'conductor', version, path: pluginCacheDir });
  fs.mkdirSync(path.dirname(installedPluginsPath), { recursive: true });
  fs.writeFileSync(installedPluginsPath, JSON.stringify(installed, null, 2));
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
