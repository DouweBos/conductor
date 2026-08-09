import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  REFERENCE_LINE,
  referenceOnLine,
  renderReference,
  resolveReference,
} from "../../../app/lib/flowRefs";
import type { FileEntry, FlowReference, FlowSearchHit } from "../../../app/lib/types";
import { getProjectInfo, listFlows } from "../file/fileService";
import { readAliases } from "./catalog";

/**
 * Every place one flow names another. A POM suite refers to subflows through
 * `runFlow`/`runScript`, in either a config.yaml alias (`@pages/…`) or a path
 * relative to the referring file — so renaming a flow has to rewrite both, in
 * whichever style the call site already used.
 */

export async function indexReferences(): Promise<FlowReference[]> {
  const project = getProjectInfo();
  if (!project) return [];
  const aliases = readAliases(project.flowsDir);
  const files = flatten(await listFlows()).filter((f) => /\.(ya?ml)$/i.test(f.name));

  const refs: FlowReference[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(path.join(project.flowsDir, file.path), "utf8");
    } catch {
      continue;
    }
    content.split(/\r?\n/).forEach((line, index) => {
      const raw = referenceOnLine(line);
      if (!raw) return;
      const target = resolveReference(raw, file.path, aliases);
      if (!target) return;
      refs.push({
        from: file.path,
        to: target,
        line: index + 1,
        text: line.trim(),
        style: raw.startsWith("@") ? "alias" : "relative",
      });
    });
  }
  return refs;
}

/** Who references this flow. */
export async function findUsages(target: string): Promise<FlowReference[]> {
  return (await indexReferences()).filter((ref) => ref.to === target);
}

/**
 * Rewrite every reference to `from` so it points at `to`. Returns the files
 * touched — the caller renames the file itself.
 */
export async function updateReferences(from: string, to: string): Promise<string[]> {
  const project = getProjectInfo();
  if (!project) return [];
  const aliases = readAliases(project.flowsDir);
  const usages = (await indexReferences()).filter((ref) => ref.to === from);

  const byFile = new Map<string, FlowReference[]>();
  for (const usage of usages) {
    byFile.set(usage.from, [...(byFile.get(usage.from) ?? []), usage]);
  }

  const touched: string[] = [];
  for (const [file, refs] of byFile) {
    const abs = path.join(project.flowsDir, file);
    const lines = (await readFile(abs, "utf8")).split(/\r?\n/);
    for (const ref of refs) {
      const line = lines[ref.line - 1];
      const match = REFERENCE_LINE.exec(line);
      if (!match) continue;
      // A file that moved is still referred to from its own (unchanged) location.
      const replacement = renderReference(to, file === from ? to : file, ref.style, aliases);
      lines[ref.line - 1] = line.replace(
        `${match[1]}${match[2]}${match[3]}`,
        `${match[1]}${match[2]}${replacement}`,
      );
    }
    await writeFile(abs, lines.join("\n"), "utf8");
    touched.push(file);
  }
  return touched;
}

/** Plain substring search across the flows directory. */
export async function searchFlows(query: string, limit = 200): Promise<FlowSearchHit[]> {
  const project = getProjectInfo();
  if (!project || !query.trim()) return [];
  const needle = query.toLowerCase();
  const hits: FlowSearchHit[] = [];
  for (const file of flatten(await listFlows())) {
    let content: string;
    try {
      content = await readFile(path.join(project.flowsDir, file.path), "utf8");
    } catch {
      continue;
    }
    content.split(/\r?\n/).forEach((line, index) => {
      if (hits.length >= limit || !line.toLowerCase().includes(needle)) return;
      hits.push({ path: file.path, line: index + 1, text: line.trim() });
    });
    if (hits.length >= limit) break;
  }
  return hits;
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
