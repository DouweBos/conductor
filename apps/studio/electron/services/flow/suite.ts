import { readFile } from "node:fs/promises";
import path from "node:path";

import type { FileEntry } from "../../../app/lib/types";
import { getProjectInfo, listFlows } from "../file/fileService";
import { run } from "../util/exec";

/**
 * Suite-level questions a test engineer asks before running anything: which
 * tags exist, and which flows did I actually change. Both come from the repo
 * rather than from typing.
 */

/** Every tag declared by a flow, with how many flows carry it. */
export async function listTags(): Promise<{ tag: string; count: number }[]> {
  const project = getProjectInfo();
  if (!project) return [];
  const counts = new Map<string, number>();
  for (const file of flatten(await listFlows()).filter((f) => /\.(ya?ml)$/i.test(f.name))) {
    let content: string;
    try {
      content = await readFile(path.join(project.flowsDir, file.path), "utf8");
    } catch {
      continue;
    }
    for (const tag of tagsOf(content)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Keys of the header's `tags:` list. */
function tagsOf(content: string): string[] {
  const header = content.split(/^---\s*$/m)[0] ?? "";
  const lines = header.split(/\r?\n/);
  const tags: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^tags:\s*$/.test(lines[i])) {
      // Inline form: `tags: [tv, smoke]`.
      const inline = /^tags:\s*\[(.+)\]\s*$/.exec(lines[i]);
      if (inline) tags.push(...inline[1].split(",").map((t) => t.trim().replace(/['"]/g, "")));
      continue;
    }
    for (let j = i + 1; j < lines.length; j++) {
      const item = /^\s+-\s*(.+?)\s*$/.exec(lines[j]);
      if (!item) break;
      tags.push(item[1].replace(/['"]/g, ""));
    }
  }
  return tags.filter(Boolean);
}

/**
 * Flows changed against a base branch — the set worth running before pushing.
 * Paths come back relative to the flows directory.
 */
export async function changedFlows(base = "main"): Promise<string[]> {
  const project = getProjectInfo();
  if (!project) return [];
  const args = ["diff", "--name-only", `${base}...HEAD`];
  const [committed, working] = await Promise.all([
    run("git", args, { cwd: project.root, timeout: 20_000 }),
    run("git", ["status", "--porcelain"], { cwd: project.root, timeout: 20_000 }),
  ]);

  const paths = new Set<string>();
  if (committed.code === 0) {
    for (const line of committed.stdout.split(/\r?\n/)) if (line.trim()) paths.add(line.trim());
  }
  for (const line of working.stdout.split(/\r?\n/)) {
    const file = line.slice(3).trim();
    if (file) paths.add(file);
  }

  // Keep only flows, and re-root them on the flows directory.
  const flowsPrefix = `${path.relative(project.root, project.flowsDir)}/`;
  const known = new Set(
    flatten(await listFlows())
      .filter((f) => /\.(ya?ml)$/i.test(f.name))
      .map((f) => f.path),
  );
  return [...paths]
    .filter((p) => p.startsWith(flowsPrefix))
    .map((p) => p.slice(flowsPrefix.length))
    .filter((p) => known.has(p))
    .sort();
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
