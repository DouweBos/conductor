import { readFile } from "node:fs/promises";
import path from "node:path";

import { getProjectInfo, listFlows, readFlow, writeFlow } from "../file/fileService";
import { testCaseIdsOf, withTestCaseIds } from "../flow/properties";
import { tagsOf } from "../flow/suite";
import type { FileEntry } from "../../../app/lib/types";

/**
 * What the repo says about coverage. A flow declares the case it verifies in
 * its own header (`properties.testCaseId`), so the flows are the record of
 * what is automated: no side-car mapping to keep in step, and CI's JUnit
 * report names the case without Studio being involved at all.
 */

export interface FlowLink {
  /** Flow path, relative to the flows directory. */
  path: string;
  /** Cases it declares — usually one. */
  refs: string[];
  /** Its Maestro tags, which is how a case's matrix column is covered. */
  tags: string[];
}

export async function flowLinks(): Promise<FlowLink[]> {
  const project = getProjectInfo();
  if (!project) return [];
  const links: FlowLink[] = [];
  for (const file of flatten(await listFlows()).filter((f) => /\.ya?ml$/i.test(f.name))) {
    let content: string;
    try {
      content = await readFile(path.join(project.flowsDir, file.path), "utf8");
    } catch {
      continue;
    }
    const refs = testCaseIdsOf(content);
    if (refs.length) links.push({ path: file.path, refs, tags: tagsOf(content) });
  }
  return links.sort((a, b) => a.path.localeCompare(b.path));
}

/** Flows by case ref, for a coverage view that reads the repo once. */
export async function linksByCase(): Promise<Map<string, FlowLink[]>> {
  const byCase = new Map<string, FlowLink[]>();
  for (const link of await flowLinks()) {
    for (const ref of link.refs) byCase.set(ref, [...(byCase.get(ref) ?? []), link]);
  }
  return byCase;
}

/**
 * Point a flow at the cases it verifies, or at none. Editing the flow is the
 * whole operation — there is nowhere else the link is recorded.
 */
export async function linkFlow(
  flowPath: string,
  refs: string[],
  priority?: string,
): Promise<FlowLink> {
  let content: string;
  try {
    content = await readFlow(flowPath);
  } catch (error) {
    // A flow that isn't there declares nothing, so unlinking it is already done.
    const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
    if (missing && !refs.length) return { path: flowPath, refs: [], tags: [] };
    if (missing) throw new Error(`No flow at ${flowPath} to link — it may have been deleted.`);
    throw error;
  }
  const next = withTestCaseIds(content, refs, priority);
  if (next !== content) await writeFlow(flowPath, next);
  return { path: flowPath, refs: testCaseIdsOf(next), tags: tagsOf(next) };
}

function flatten(entries: FileEntry[]): FileEntry[] {
  return entries.flatMap((entry) => (entry.children ? flatten(entry.children) : [entry]));
}
