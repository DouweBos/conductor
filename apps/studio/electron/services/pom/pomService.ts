import { readFile } from "node:fs/promises";
import path from "node:path";

import type { FileEntry, PomEntry } from "../../../app/lib/types";
import { listFlows } from "../file/fileService";
import { getProjectInfo } from "../file/fileService";

/**
 * Index the project's reusable Maestro subflows as a Page-Object-Model catalog.
 * A subflow is any flow that declares `env:` params — the agent composes these
 * via `runFlow` rather than re-deriving selectors.
 *
 * This is the data layer for the (scaffolded) agentic writer; the live agent
 * runner is a follow-on.
 */
export async function listPoms(): Promise<PomEntry[]> {
  const project = getProjectInfo();
  if (!project) return [];
  const tree = await listFlows();
  const files = flatten(tree).filter((f) => /\.(ya?ml)$/i.test(f.name));
  const entries: PomEntry[] = [];
  for (const file of files) {
    const abs = path.join(project.flowsDir, file.path);
    try {
      const content = await readFile(abs, "utf8");
      const params = extractEnvKeys(content);
      // Only treat parameterized flows as POM subflows.
      if (params.length > 0) {
        entries.push({
          path: file.path,
          name: file.name.replace(/\.(ya?ml)$/i, ""),
          params,
          screen: inferScreen(file.name),
        });
      }
    } catch {
      // skip unreadable files
    }
  }
  return entries;
}

function flatten(entries: FileEntry[]): FileEntry[] {
  const out: FileEntry[] = [];
  const walk = (list: FileEntry[]) => {
    for (const e of list) {
      if (e.type === "file") out.push(e);
      if (e.children) walk(e.children);
    }
  };
  walk(entries);
  return out;
}

/** Extract keys from the flow's leading `env:` block (the Maestro header). */
function extractEnvKeys(content: string): string[] {
  const header = content.split(/^---$/m)[0] ?? content;
  const lines = header.split(/\r?\n/);
  const keys: string[] = [];
  let inEnv = false;
  for (const line of lines) {
    if (/^env:\s*$/.test(line)) {
      inEnv = true;
      continue;
    }
    if (inEnv) {
      const match = line.match(/^\s{2,}([A-Za-z0-9_]+):/);
      if (match) keys.push(match[1]);
      else if (/^\S/.test(line)) inEnv = false;
    }
  }
  return keys;
}

function inferScreen(fileName: string): string | undefined {
  const base = fileName.replace(/\.(ya?ml)$/i, "");
  return base.replace(/[-_]/g, " ");
}
