import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { FlowRunStatus } from "../../../app/lib/types";
import { run } from "../util/exec";

/**
 * Per-flow results from a CI run. A workflow's job names only ever give a coarse
 * pass/fail, but the JUnit report uploaded as an artifact names every flow, so
 * that's what test cases should bind to.
 */

export interface JunitCase {
  /** Flow name as maestro reports it, e.g. `login` for login.yaml. */
  name: string;
  status: FlowRunStatus;
  /** Failure text, when it failed. */
  detail?: string;
}

/** Download a run's artifacts with `gh` and read every JUnit report inside. */
export async function junitForRun(cwd: string, runId: number): Promise<JunitCase[]> {
  const dir = mkdtempSync(path.join(tmpdir(), "studio-junit-"));
  const res = await run("gh", ["run", "download", String(runId), "--dir", dir], {
    cwd,
    timeout: 120_000,
  });
  // No artifacts is a normal outcome, not an error worth throwing over.
  if (res.code !== 0 && !existsSync(dir)) return [];

  const cases: JunitCase[] = [];
  for (const file of findXml(dir)) {
    try {
      cases.push(...parseJunit(readFileSync(file, "utf8")));
    } catch {
      // A malformed report shouldn't lose the others.
    }
  }
  return cases;
}

function findXml(dir: string, depth = 4): string[] {
  if (depth < 0 || !existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...findXml(full, depth - 1));
    else if (name.endsWith(".xml")) out.push(full);
  }
  return out;
}

/**
 * Read `<testcase name="…">` elements and their failure children. Deliberately
 * regex-based: a JUnit report is flat, and this avoids an XML dependency for it.
 */
export function parseJunit(xml: string): JunitCase[] {
  const cases: JunitCase[] = [];
  // Attributes must be lazy: a greedy `[^>]*` eats the `/` of a self-closing
  // tag, so the case swallows the next one and steals its failure.
  const testcase = /<testcase\b([^>]*?)\s*(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(testcase)) {
    const attrs = match[1];
    const body = match[2] ?? "";
    const name = decode(attribute(attrs, "name"));
    if (!name) continue;
    const failed = /<(failure|error)\b/.test(body);
    const skipped = /<skipped\b/.test(body);
    cases.push({
      name,
      status: failed ? "failed" : skipped ? "cancelled" : "passed",
      detail: failed
        ? decode(attribute(/<(?:failure|error)\b([^>]*)/.exec(body)?.[1] ?? "", "message"))
        : undefined,
    });
  }
  return cases;
}

function attribute(attrs: string, name: string): string | undefined {
  return new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1];
}

const ENTITIES: Record<string, string> = {
  "&quot;": '"',
  "&apos;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
};

function decode(value: string | undefined): string | undefined {
  return value?.replace(/&(?:quot|apos|lt|gt|amp);/g, (entity) => ENTITIES[entity] ?? entity);
}

/** Does this JUnit case correspond to that flow file? */
export function matchesFlow(caseName: string, flow: string): boolean {
  const base = (flow.split("/").pop() ?? flow).replace(/\.[^.]+$/, "").toLowerCase();
  const name = caseName.toLowerCase();
  return name === base || name.endsWith(`/${base}`) || name.includes(base);
}
