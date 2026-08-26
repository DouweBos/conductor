import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FlowCatalogEntry, StepCoverage } from "../../../app/lib/types";
import type { Case } from "./model";
import { getProjectInfo } from "../file/fileService";
import { loadFlowCatalog } from "../flow/catalog";
import { indexReferences } from "../flow/references";
import { listTags } from "../flow/suite";
import { flowFor, listCases } from "./casesService";

/**
 * The seam between a human-readable case and the Maestro flow behind it.
 *
 * Steps name the page object that performs them (`pom:`), which buys three
 * things: a flow can be scaffolded from a case instead of written from scratch,
 * a flow can be checked against the case it claims to implement, and the case
 * panel can show which steps are automated and which are still hands-on.
 */

function requireProject() {
  const project = getProjectInfo();
  if (!project) throw new Error("No project is open.");
  return project;
}

/** `pages/details/open.yaml` -> `@pages/details/open.yaml` when an alias covers it. */
function callFor(entry: FlowCatalogEntry | undefined, pom: string): string {
  return entry?.alias ?? pom;
}

export interface ScaffoldOptions {
  ref: string;
  /** Platform column this flow covers; also picks the file suffix. */
  column?: string;
  /** Flows-relative target; derived from the case when omitted. */
  target?: string;
  /** Extra Maestro tags for the header. */
  tags?: string[];
}

/** Where a case's flow lands by default: `flows/cases/<ref>[.<column>].yaml`. */
function defaultTarget(testCase: Case, column?: string): string {
  const slug = testCase.ref.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return path.posix.join("flows", "cases", `${slug}${column ? `.${column}` : ""}.yaml`);
}

/**
 * Write a runnable Maestro skeleton from the case's steps. Steps that name a
 * page object become `runFlow` calls with their env; steps that don't become a
 * TODO carrying the expected result, so the gap is visible in the file rather
 * than silently missing.
 */
export async function scaffoldFlow(options: ScaffoldOptions): Promise<{ flow: string; todos: number }> {
  const project = requireProject();
  const testCase = (await listCases()).find((c) => c.ref === options.ref);
  if (!testCase) throw new Error(`No case ${options.ref}.`);
  if (!testCase.steps?.length) {
    throw new Error(`Case ${testCase.ref} has no structured steps to scaffold from.`);
  }

  const catalog = await loadFlowCatalog();
  const byPath = new Map(catalog.entries.map((e) => [e.path, e]));
  const target = options.target ?? defaultTarget(testCase, options.column);
  const abs = path.resolve(project.flowsDir, target);
  if (existsSync(abs)) throw new Error(`${target} already exists.`);

  // A scaffold is not a tested flow. Where the project already keeps drafts out
  // of its suites with a `<something>-draft` tag, follow that convention rather
  // than enrolling an unverified flow into CI.
  const known = await listTags();
  const draftSuffix = known.some((t) => t.tag.endsWith("-draft"));
  const columnTag = options.column
    ? draftSuffix
      ? `${options.column}-draft`
      : options.column
    : undefined;
  const tags = [
    ...(columnTag ? [columnTag] : []),
    ...(testCase.suite ? [testCase.suite] : []).map((a) => a.toLowerCase().replace(/[^a-z0-9]+/g, "-")),
    ...(options.tags ?? []),
  ].filter(Boolean);

  const lines: string[] = [
    `# ${testCase.ref} — ${testCase.title}`,
    ...(testCase.description ? [`#`, ...testCase.description.split("\n").map((l) => `# ${l}`)] : []),
    "#",
    "# Scaffolded from the test case. Every step below is one of its steps; a",
    "# TODO marks a step with no page object yet.",
    "appId: ${APP_ID}",
    // The link: Maestro carries it into the JUnit report, so the case is named
    // wherever this flow runs, Studio or not.
    "properties:",
    `  testCaseId: "${testCase.ref}"`,
  ];
  if (tags.length) lines.push("tags:", ...[...new Set(tags)].map((t) => `  - ${t}`));
  lines.push("---");

  for (const pre of (testCase.preconditions ?? "").split("\n").filter(Boolean)) {
    lines.push(`# Precondition: ${pre}`);
  }

  let todos = 0;
  testCase.steps.forEach((step, i) => {
    lines.push("", `# Step ${i + 1}: ${step.action}`);
    if (step.data) lines.push(`# Data: ${step.data}`);
    if (step.expected_result) lines.push(`# Expected: ${step.expected_result}`);
    if (!step.pom) {
      todos += 1;
      lines.push(`# TODO: no page object for this step — add one under pages/ and set`);
      lines.push(`#       \`pom:\` on step ${i + 1} of ${testCase.ref}.`);
      return;
    }
    const call = callFor(byPath.get(step.pom), step.pom);
    if (step.env && Object.keys(step.env).length) {
      lines.push("- runFlow:", `    file: '${call}'`, "    env:");
      for (const [key, value] of Object.entries(step.env)) lines.push(`      ${key}: ${value}`);
    } else {
      lines.push(`- runFlow: '${call}'`);
    }
  });

  for (const post of (testCase.postconditions ?? "").split("\n").filter(Boolean)) {
    lines.push("", `# Postcondition: ${post}`);
  }

  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, `${lines.join("\n")}\n`, "utf8");

  return { flow: target, todos };
}

/**
 * Does the flow actually do what the case says? A step is backed when the flow
 * (or anything it calls) reaches the page object the step names.
 */
export async function stepCoverage(ref: string, column?: string): Promise<StepCoverage> {
  const testCase = (await listCases()).find((c) => c.ref === ref);
  if (!testCase) throw new Error(`No case ${ref}.`);
  const flow = flowFor(testCase, column);
  const reached = flow ? await reachableFrom(flow) : new Set<string>();

  const steps = (testCase.steps ?? []).map((step, index) => ({
    index,
    action: step.action,
    pom: step.pom,
    backed: Boolean(step.pom && reached.has(step.pom)),
  }));
  const claimed = new Set(steps.map((s) => s.pom).filter(Boolean) as string[]);
  return {
    ref,
    column,
    flow,
    steps,
    // Page objects the flow calls that no step mentions — the case is behind
    // the flow, or the flow is doing more than the case says.
    extra: [...reached].filter((p) => !claimed.has(p) && /^pages\//.test(p)).sort(),
  };
}

/** Everything a flow calls, transitively. */
async function reachableFrom(flow: string): Promise<Set<string>> {
  const refs = await indexReferences();
  const out = new Map<string, string[]>();
  for (const ref of refs) out.set(ref.from, [...(out.get(ref.from) ?? []), ref.to]);
  const seen = new Set<string>();
  const queue = [flow];
  while (queue.length) {
    const next = queue.shift()!;
    for (const to of out.get(next) ?? []) {
      if (seen.has(to)) continue;
      seen.add(to);
      queue.push(to);
    }
  }
  return seen;
}

/** Page objects, for the step editor to choose from. */
export async function listStepPoms(): Promise<FlowCatalogEntry[]> {
  const catalog = await loadFlowCatalog();
  return catalog.entries
    .filter((e) => e.kind === "flow" && /^(pages|commands)\//.test(e.path))
    .sort((a, b) => a.path.localeCompare(b.path));
}



/** Read a scaffolded flow back, for the "what did we just write" preview. */
export async function readFlowText(flow: string): Promise<string> {
  const project = requireProject();
  return readFile(path.resolve(project.flowsDir, flow), "utf8");
}
