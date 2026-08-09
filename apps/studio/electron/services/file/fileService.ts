import { dialog } from "electron";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FileEntry, ProjectInfo, RenameResult } from "../../../app/lib/types";
import { appState } from "../../state";
import { addRecentProject, getRecentProjects } from "../settings/settingsService";
import { updateReferences } from "../flow/references";

const FLOW_DIR_NAMES = new Set([".maestro", "maestro"]);
const FLOW_EXTENSIONS = new Set([".yaml", ".yml", ".js", ".ts"]);
const YAML_EXTENSIONS = new Set([".yaml", ".yml"]);
const IGNORED = new Set(["node_modules", ".git", ".DS_Store"]);
/** Never worth descending into when hunting for flows. */
const NOT_SEARCHED = new Set([
  "node_modules", ".git", ".jj", "dist", "build", "out", "target", "vendor", "Pods",
  ".gradle", ".idea", ".next", ".expo", ".turbo", ".yarn", "DerivedData", "coverage",
]);
/** Monorepos keep flows next to an app, not at the repo root — so look down a bit. */
const FLOW_SEARCH_DEPTH = 4;

let projectInfo: ProjectInfo | null = null;

/**
 * Does this directory hold something that's actually a Maestro flow? A YAML file
 * alone isn't enough — `.github/actions/maestro` is full of them — so look for a
 * flow's shape: an `appId:` header or the `---` that separates it from the steps.
 */
function holdsMaestroFlow(dir: string, depth = 3, budget = { files: 24 }): boolean {
  let dirents;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const dirent of dirents) {
    if (budget.files <= 0) return false;
    if (!dirent.isFile() || !YAML_EXTENSIONS.has(path.extname(dirent.name))) continue;
    budget.files -= 1;
    try {
      const head = readFileSync(path.join(dir, dirent.name), "utf8").slice(0, 4096);
      if (/^appId:/m.test(head) || /^---\s*$/m.test(head)) return true;
    } catch {
      // unreadable — keep looking
    }
  }
  if (depth <= 0) return false;
  return dirents.some(
    (d) =>
      d.isDirectory() &&
      !NOT_SEARCHED.has(d.name) &&
      holdsMaestroFlow(path.join(dir, d.name), depth - 1, budget),
  );
}

/**
 * Every flows directory in the repo, shallowest first. A monorepo commonly keeps
 * them per-app (e.g. `apps/plex/.maestro`), so the repo root alone isn't enough.
 */
export function findFlowDirs(root: string, depth = FLOW_SEARCH_DEPTH): string[] {
  const found: string[] = [];
  const walk = (dir: string, left: number) => {
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const abs = path.join(dir, dirent.name);
      if (FLOW_DIR_NAMES.has(dirent.name)) {
        // Matched — its contents are flows, not more candidates.
        if (holdsMaestroFlow(abs)) found.push(abs);
        continue;
      }
      // Hidden and build directories never hold a project's flows.
      if (dirent.name.startsWith(".") || NOT_SEARCHED.has(dirent.name)) continue;
      if (left > 0) walk(abs, left - 1);
    }
  };
  walk(root, depth);
  return found.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));
}

function detectFlowsDir(root: string): string {
  const legacy = path.join(root, ".conductor", "flows");
  if (existsSync(legacy)) return legacy;
  // Default target — created lazily on first flow write.
  return findFlowDirs(root)[0] ?? path.join(root, ".maestro");
}

/** Walk up from a starting dir to the nearest git repo root, else return start. */
function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

function defaultRoot(): string {
  const lastOpened = getRecentProjects().find((root) => existsSync(root));
  if (lastOpened) return lastOpened;
  return findRepoRoot(process.env.STUDIO_PROJECT_ROOT ?? process.cwd());
}

/** Recently opened roots, most-recent first; entries that vanished are dropped. */
export function listRecentProjects(): ProjectInfo[] {
  return getRecentProjects()
    .filter((root) => existsSync(root))
    .map((root) => ({ root, name: path.basename(root), flowsDir: detectFlowsDir(root), flowsDirs: [] }));
}

export async function openProject(root?: string): Promise<ProjectInfo> {
  const resolved = root ? path.resolve(root) : defaultRoot();
  if (!existsSync(resolved)) {
    throw new Error(`Project path does not exist: ${resolved}`);
  }
  const flowsDir = detectFlowsDir(resolved);
  projectInfo = {
    root: resolved,
    name: path.basename(resolved),
    flowsDir,
    flowsDirs: findFlowDirs(resolved),
  };
  appState.projectRoot = resolved;
  addRecentProject(resolved);
  return projectInfo;
}

/** Native folder picker → open. Returns null when the user cancels. */
export async function pickProject(): Promise<ProjectInfo | null> {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "Open project",
    message: "Choose the repo that holds your app's Maestro flows",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: projectInfo?.root,
    buttonLabel: "Open",
  });
  if (canceled || !filePaths[0]) return null;
  return openProject(filePaths[0]);
}

export function getProjectInfo(): ProjectInfo | null {
  return projectInfo;
}

/** Switch which discovered flows directory the workbench shows. */
export function setFlowsDir(dir: string): ProjectInfo {
  const project = requireProject();
  const abs = path.resolve(project.root, dir);
  if (!existsSync(abs)) throw new Error(`Flows directory does not exist: ${abs}`);
  projectInfo = { ...project, flowsDir: abs };
  return projectInfo;
}

function requireProject(): ProjectInfo {
  if (!projectInfo) throw new Error("No project is open. Open a project first.");
  return projectInfo;
}

/** Resolve a flows-relative path and guarantee it stays inside flowsDir. */
function resolveInFlows(relPath: string): string {
  const { flowsDir } = requireProject();
  const abs = path.resolve(flowsDir, relPath);
  const rel = path.relative(flowsDir, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes the flows directory: ${relPath}`);
  }
  return abs;
}

async function readTree(dir: string, base: string): Promise<FileEntry[]> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const entries: FileEntry[] = [];
  for (const dirent of dirents) {
    if (IGNORED.has(dirent.name) || dirent.name.startsWith(".")) continue;
    const abs = path.join(dir, dirent.name);
    const rel = path.relative(base, abs);
    if (dirent.isDirectory()) {
      const children = await readTree(abs, base);
      if (children.length > 0) {
        entries.push({ path: rel, name: dirent.name, type: "dir", children });
      }
    } else if (FLOW_EXTENSIONS.has(path.extname(dirent.name))) {
      entries.push({ path: rel, name: dirent.name, type: "file" });
    }
  }
  // Directories first, then files, each alphabetical.
  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function listFlows(): Promise<FileEntry[]> {
  const { flowsDir } = requireProject();
  return readTree(flowsDir, flowsDir);
}

export async function readFlow(relPath: string): Promise<string> {
  return readFile(resolveInFlows(relPath), "utf8");
}

export async function writeFlow(relPath: string, content: string): Promise<void> {
  const abs = resolveInFlows(relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}

export async function createFlow(relPath: string, content = ""): Promise<void> {
  const abs = resolveInFlows(relPath);
  if (existsSync(abs)) throw new Error(`File already exists: ${relPath}`);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}

export async function deleteFlow(relPath: string): Promise<void> {
  await rm(resolveInFlows(relPath), { recursive: true, force: true });
}

/**
 * Rename a flow and repoint everything that calls it — a POM suite refers to a
 * subflow from a dozen places, and leaving those dangling breaks the suite
 * silently.
 */
export async function renameFlow(from: string, to: string): Promise<RenameResult> {
  const absFrom = resolveInFlows(from);
  const absTo = resolveInFlows(to);
  const updated = await updateReferences(from, to);
  await mkdir(path.dirname(absTo), { recursive: true });
  await rename(absFrom, absTo);
  return { updated };
}

export async function duplicateFlow(from: string, to: string): Promise<void> {
  const absTo = resolveInFlows(to);
  if (existsSync(absTo)) throw new Error(`File already exists: ${to}`);
  const content = await readFile(resolveInFlows(from), "utf8");
  await mkdir(path.dirname(absTo), { recursive: true });
  await writeFile(absTo, content, "utf8");
}

export async function createFolder(relPath: string): Promise<void> {
  await mkdir(resolveInFlows(relPath), { recursive: true });
}
