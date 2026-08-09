import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FileEntry, ProjectInfo } from "../../../app/lib/types";
import { appState } from "../../state";

const FLOW_DIR_CANDIDATES = [".maestro", "maestro", "flows", ".conductor/flows"];
const FLOW_EXTENSIONS = new Set([".yaml", ".yml", ".js", ".ts"]);
const IGNORED = new Set(["node_modules", ".git", ".DS_Store"]);

let projectInfo: ProjectInfo | null = null;

function detectFlowsDir(root: string): string {
  for (const candidate of FLOW_DIR_CANDIDATES) {
    const dir = path.join(root, candidate);
    if (existsSync(dir)) return dir;
  }
  // Default target — created lazily on first flow write.
  return path.join(root, ".maestro");
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

export async function openProject(root?: string): Promise<ProjectInfo> {
  const resolved = root
    ? path.resolve(root)
    : findRepoRoot(process.env.STUDIO_PROJECT_ROOT ?? process.cwd());
  if (!existsSync(resolved)) {
    throw new Error(`Project path does not exist: ${resolved}`);
  }
  const flowsDir = detectFlowsDir(resolved);
  projectInfo = {
    root: resolved,
    name: path.basename(resolved),
    flowsDir,
  };
  appState.projectRoot = resolved;
  return projectInfo;
}

export function getProjectInfo(): ProjectInfo | null {
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

export async function renameFlow(from: string, to: string): Promise<void> {
  const absFrom = resolveInFlows(from);
  const absTo = resolveInFlows(to);
  await mkdir(path.dirname(absTo), { recursive: true });
  await rename(absFrom, absTo);
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
