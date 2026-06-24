export const HELP = `  init [target-dir]                    Set up conductor in a repo: install the agent skills into .claude/skills/
                                       Interactive when run in a terminal; non-interactive otherwise.
    --global                          Install into ~/.claude/skills/ instead of the current repo
    --force                           Re-sync skills that are already installed (overwrite)
    --yes, -y                         Skip prompts and accept defaults (install all skills)`;

import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline/promises';
import { printError, printData } from '../output.js';
import { findPkgRoot } from '../pkg-root.js';

/** Skills conductor installs are namespaced with this prefix; prune is bounded to it. */
const SKILL_PREFIX = 'conductor-';

/** Records what conductor installed into a skills dir, so we can detect staleness and prune. */
const MANIFEST_FILE = '.conductor-skills.json';

interface Manifest {
  /** conductor version that last wrote these skills. */
  version: string;
  /** managed skill directory names present after that write. */
  skills: string[];
}

/**
 * The skill templates ship inside the published package under `skills/`
 * (declared in package.json `files`), one directory per `conductor-<capability>`
 * skill, each containing a SKILL.md. `findPkgRoot` resolves the package root for
 * both the production build (dist/) and the test build (which has an extra `src/`
 * path level), mirroring how the bundled drivers are located.
 */
function bundledSkillsRoot(): string {
  return path.join(findPkgRoot(__dirname), 'skills');
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(findPkgRoot(__dirname), 'package.json'), 'utf-8')
    );
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Enumerate bundled skill directories (those containing a SKILL.md). */
function listBundledSkills(skillsRoot: string): string[] {
  if (!fs.existsSync(skillsRoot)) return [];
  return fs
    .readdirSync(skillsRoot)
    .filter((name) => fs.existsSync(path.join(skillsRoot, name, 'SKILL.md')))
    .sort();
}

function readManifest(destRoot: string): Manifest | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(destRoot, MANIFEST_FILE), 'utf-8'));
    if (raw && Array.isArray(raw.skills)) {
      return { version: String(raw.version ?? 'unknown'), skills: raw.skills.map(String) };
    }
  } catch {
    /* missing or corrupt → treat as no prior install */
  }
  return null;
}

function writeManifest(destRoot: string, manifest: Manifest): void {
  fs.mkdirSync(destRoot, { recursive: true });
  fs.writeFileSync(path.join(destRoot, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');
}

function copySkill(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir)) {
    const from = path.join(srcDir, entry);
    if (!fs.statSync(from).isFile()) continue;
    fs.copyFileSync(from, path.join(destDir, entry));
  }
}

/**
 * Remove skills conductor previously installed that are no longer bundled (renamed
 * or dropped). Bounded to skills recorded in our manifest and the `conductor-`
 * prefix, so it never touches user-authored or third-party skills.
 */
function pruneOrphans(destRoot: string, prev: Manifest | null, bundled: Set<string>): string[] {
  if (!prev) return [];
  const pruned: string[] = [];
  for (const name of prev.skills) {
    if (!name.startsWith(SKILL_PREFIX) || bundled.has(name)) continue;
    const dir = path.join(destRoot, name);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      pruned.push(name);
    }
  }
  return pruned;
}

interface Plan {
  destRoot: string;
  selected: string[];
  force: boolean;
}

function resolveDestRoot(global: boolean, targetDir: string | undefined): string {
  return global
    ? path.join(os.homedir(), '.claude', 'skills')
    : path.join(path.resolve(targetDir ?? process.cwd()), '.claude', 'skills');
}

/**
 * Setting up conductor is the one manual, human-driven step — so when `init` runs
 * in a real terminal we walk the dev through scope and skill selection, the way
 * argent's wizard does. Headless/agent/CI runs (no TTY, --json, or --yes) take the
 * non-interactive path with sensible defaults: all skills, project scope.
 */
async function promptPlan(
  skills: string[],
  version: string,
  targetDir: string | undefined,
  flags: { global: boolean; force: boolean }
): Promise<Plan> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    // Scope — skip the prompt if the flags already decided it.
    let global = flags.global;
    if (!flags.global && targetDir === undefined) {
      const ans = (
        await rl.question(
          'Where should the skills be installed?\n' +
            '  1) This project (./.claude/skills)  [default]\n' +
            '  2) Globally (~/.claude/skills)\n' +
            '> '
        )
      ).trim();
      global = ans === '2';
    }
    const destRoot = resolveDestRoot(global, targetDir);

    // Skill selection.
    let selected = skills;
    const sel = (
      await rl.question(
        `\nInstall all ${skills.length} skills, or choose a subset?\n` +
          '  1) All  [default]\n' +
          '  2) Select\n' +
          '> '
      )
    ).trim();
    if (sel === '2') {
      skills.forEach((name, i) => console.log(`  ${i + 1}) ${name}`));
      const picks = (await rl.question('Enter numbers (comma-separated): ')).trim();
      const chosen = picks
        .split(',')
        .map((s) => parseInt(s.trim(), 10) - 1)
        .filter((i) => i >= 0 && i < skills.length)
        .map((i) => skills[i]);
      if (chosen.length > 0) selected = [...new Set(chosen)];
    }

    // Offer to re-sync already-installed skills. If they're from an older
    // conductor, say so and default to yes; otherwise default to no.
    let force = flags.force;
    if (!force) {
      const existing = selected.filter((name) => fs.existsSync(path.join(destRoot, name)));
      if (existing.length > 0) {
        const prev = readManifest(destRoot);
        const stale = prev !== null && prev.version !== version;
        const prompt = stale
          ? `\n${existing.length} installed skill(s) are from conductor v${prev?.version} (this is v${version}). Re-sync (overwrite) them? [Y/n] `
          : `\n${existing.length} of these are already installed. Re-sync (overwrite) them? [y/N] `;
        const ans = (await rl.question(prompt)).trim().toLowerCase();
        force = stale ? ans !== 'n' && ans !== 'no' : ans === 'y' || ans === 'yes';
      }
    }

    return { destRoot, selected, force };
  } finally {
    rl.close();
  }
}

export async function init(
  opts: { json: boolean },
  targetDir: string | undefined,
  flags: { global: boolean; force: boolean; yes: boolean }
): Promise<number> {
  try {
    if (targetDir !== undefined && flags.global) {
      printError('init: pass a target directory or --global, not both.', opts);
      return 1;
    }

    const srcRoot = bundledSkillsRoot();
    const skills = listBundledSkills(srcRoot);
    if (skills.length === 0) {
      printError(`No bundled skill templates found at ${srcRoot}`, opts);
      return 1;
    }
    const version = packageVersion();
    const bundledSet = new Set(skills);

    const interactive =
      !opts.json && !flags.yes && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

    const plan: Plan = interactive
      ? await promptPlan(skills, version, targetDir, flags)
      : {
          destRoot: resolveDestRoot(flags.global, targetDir),
          selected: skills,
          force: flags.force,
        };

    const prev = readManifest(plan.destRoot);

    const installed: string[] = [];
    const skipped: string[] = [];
    for (const name of plan.selected) {
      const destDir = path.join(plan.destRoot, name);
      if (fs.existsSync(destDir) && !plan.force) {
        skipped.push(name);
        continue;
      }
      copySkill(path.join(srcRoot, name), destDir);
      installed.push(name);
    }

    // Remove skills we previously installed that are no longer bundled.
    const pruned = pruneOrphans(plan.destRoot, prev, bundledSet);

    // Update the manifest. Only claim the current version when we fully re-synced
    // (force); otherwise existing skills may still be stale, so keep the old stamp.
    const present = skills.filter((name) => fs.existsSync(path.join(plan.destRoot, name)));
    if (present.length > 0) {
      const stampVersion = !prev || plan.force ? version : prev.version;
      writeManifest(plan.destRoot, { version: stampVersion, skills: present });
    }

    const stale = !plan.force && prev !== null && prev.version !== version && skipped.length > 0;

    if (opts.json) {
      printData(
        { status: 'ok', dir: plan.destRoot, version, installed, skipped, pruned, stale },
        opts
      );
      return 0;
    }

    // argent-style messaging.
    if (installed.length > 0) {
      console.log(`\nInstalling skills…`);
      for (const name of installed) console.log(`  + ${name}`);
      console.log(`Skills installed → ${plan.destRoot}`);
    }
    if (pruned.length > 0) {
      console.log(`Pruned skills no longer shipped: ${pruned.join(', ')}`);
    }
    if (skipped.length > 0) {
      console.log(
        `Already installed (skipped): ${skipped.join(', ')}. Re-run with --force to re-sync.`
      );
    }
    if (stale) {
      console.log(
        `Note: skipped skills are from conductor v${prev?.version} (this is v${version}). Re-run \`conductor init --force\` to update them.`
      );
    }
    if (installed.length === 0 && pruned.length === 0 && skipped.length > 0) {
      console.log('Nothing to do — all selected skills already installed.');
    } else {
      console.log(
        'Conductor is ready. Restart your agent / Claude Code session to pick up the skills.'
      );
    }
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    printError(`init failed: ${message}`, opts);
    // Manual fallback, in the spirit of argent's "install manually" note.
    if (!opts.json) {
      console.error('To install manually, copy the bundled skills into your skills directory:');
      console.error(`  cp -r "${bundledSkillsRoot()}"/* ./.claude/skills/`);
    }
    return 1;
  }
}
