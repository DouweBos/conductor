import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { FileEntry } from "../../../app/lib/types";
import { getProjectInfo, listFlows } from "../file/fileService";

/**
 * Every env variable name the project's flows know about: the keys declared in
 * `env:` blocks (a subflow's parameters) and every `${VAR}` already referenced,
 * plus anything in the flows directory's `config.yaml`. Feeds `${…}` completion
 * in the editor, so a flow can be written against the suite's existing vocabulary.
 */

const MAX_FILES = 400;

export async function listEnvNames(): Promise<string[]> {
  const project = getProjectInfo();
  if (!project) return [];
  const names = new Set<string>();

  const config = path.join(project.flowsDir, "config.yaml");
  if (existsSync(config)) await collect(config, names);

  const files = flatten(await listFlows())
    .filter((f) => /\.(ya?ml)$/i.test(f.name))
    .slice(0, MAX_FILES);
  for (const file of files) {
    await collect(path.join(project.flowsDir, file.path), names);
  }
  return [...names].sort();
}

async function collect(file: string, into: Set<string>): Promise<void> {
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch {
    return;
  }
  for (const name of envBlockKeys(content)) into.add(name);
  for (const match of content.matchAll(/\$\{\s*([A-Za-z_]\w*)/g)) into.add(match[1]);
}

/** Keys of every `env:` block, at any indentation (headers and runFlow alike). */
function envBlockKeys(content: string): string[] {
  const keys: string[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const start = /^(\s*)env:\s*$/.exec(lines[i]);
    if (!start) continue;
    const indent = start[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) continue;
      if (line.length - line.trimStart().length <= indent) break;
      const key = /^\s*([A-Za-z_]\w*)\s*:/.exec(line);
      if (key) keys.push(key[1]);
    }
  }
  return keys;
}

function flatten(entries: FileEntry[]): FileEntry[] {
  const out: FileEntry[] = [];
  const walk = (list: FileEntry[]) => {
    for (const entry of list) {
      if (entry.type === "file") out.push(entry);
      if (entry.children) walk(entry.children);
    }
  };
  walk(entries);
  return out;
}
