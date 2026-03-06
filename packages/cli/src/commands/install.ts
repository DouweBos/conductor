import fs from 'fs';
import os from 'os';
import path from 'path';
import { printSuccess, printError, printData } from '../output.js';
import { findPkgRoot } from '../pkg-root.js';

export async function installSkills(
  opts: { json: boolean },
  skillsOnly = false,
  check = false
): Promise<number> {
  try {
    if (check) {
      return checkInstallStatus(opts);
    }
    if (skillsOnly) {
      installLocalSkills();
      printSuccess('Conductor skills installed → .claude/skills/conductor/', opts);
    } else {
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
    }
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    printError(`Install failed: ${message}`, opts);
    return 1;
  }
}

function checkInstallStatus(opts: { json: boolean }): number {
  const installedPluginsPath = path.join(
    os.homedir(),
    '.claude',
    'plugins',
    'installed_plugins.json'
  );
  const localSkillsPath = path.join(process.cwd(), '.claude', 'skills', 'conductor', 'SKILL.md');

  let pluginVersion: string | null = null;
  if (fs.existsSync(installedPluginsPath)) {
    const installed = JSON.parse(fs.readFileSync(installedPluginsPath, 'utf8')) as {
      plugins: { name: string; version: string }[];
    };
    const entry = installed.plugins.find((p) => p.name === 'conductor');
    if (entry) pluginVersion = entry.version;
  }

  const hasLocalSkills = fs.existsSync(localSkillsPath);

  if (opts.json) {
    printData(
      {
        globalPlugin: { installed: pluginVersion !== null, version: pluginVersion },
        localSkills: { installed: hasLocalSkills },
      },
      opts
    );
  } else {
    if (pluginVersion) {
      console.log(`Global plugin: installed (v${pluginVersion})`);
    } else {
      console.log('Global plugin: not installed');
    }

    if (hasLocalSkills) {
      console.log('Local skills: installed → .claude/skills/conductor/');
    } else {
      console.log('Local skills: not installed');
    }

    if (!pluginVersion && !hasLocalSkills) {
      console.log('\nRun `conductor install` to install the global plugin.');
      console.log('Run `conductor install --skills` to copy skills into this project.');
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
  }

  installed.plugins = installed.plugins.filter((p) => p.name !== 'conductor');
  installed.plugins.push({ name: 'conductor', version, path: pluginCacheDir });
  fs.mkdirSync(path.dirname(installedPluginsPath), { recursive: true });
  fs.writeFileSync(installedPluginsPath, JSON.stringify(installed, null, 2));

  return version;
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
