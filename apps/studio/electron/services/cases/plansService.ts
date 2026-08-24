import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { PlanRun, PlanRunEntry, TestPlan, TestPlanInput } from "../../../app/lib/types";
import { broadcastToRenderers } from "../../broadcast";
import { caseProjectDir, selectedProjects, targetProject } from "./projects";
import { awaitRun, cancelRun, runFlow } from "../flow/flowRunner";
import { listCases } from "./casesService";
import type { Case } from "./model";
import { claimRunForPlan, recordResult } from "./resultsService";

/**
 * Test plans: a named selection of cases to execute together — "release smoke",
 * "everything high priority on tv". Stored beside the cases under
 * `~/.conductor/studio`, not in the repo under test.
 *
 * A plan run walks its cases in order, runs each one's flow, and files the
 * outcome as an execution of that case. Cases with no flow are skipped and said
 * to be skipped, rather than quietly dropped.
 */

/** Plans are per sub-project: a plan's case refs only mean something in one. */
function plansRoot(projectId?: string): string {
  return caseProjectDir("plans", projectId ?? targetProject().id);
}

export async function listPlans(): Promise<TestPlan[]> {
  const perProject = await Promise.all(selectedProjects().map((p) => readPlans(plansRoot(p.id))));
  return perProject.flat().sort((a, b) => a.name.localeCompare(b.name));
}

async function readPlans(root: string): Promise<TestPlan[]> {
  if (!existsSync(root)) return [];
  const plans: TestPlan[] = [];
  for (const file of (await readdir(root)).filter((f) => /\.(ya?ml)$/i.test(f))) {
    const abs = path.join(root, file);
    try {
      const raw = parseYaml(await readFile(abs, "utf8")) as Record<string, unknown>;
      const id = String(raw?.id ?? "").trim();
      const name = String(raw?.name ?? "").trim();
      if (!id || !name) continue;
      plans.push({
        id,
        name,
        description: raw.description ? String(raw.description) : undefined,
        refs: Array.isArray(raw.refs) ? raw.refs.map(String) : undefined,
        filter: normalizeFilter(raw.filter),
        columns: Array.isArray(raw.columns) ? raw.columns.map(String) : undefined,
        filePath: abs,
      });
    } catch {
      // skip malformed plans
    }
  }
  return plans;
}

function normalizeFilter(raw: unknown): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const filter: Record<string, string[]> = {};
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    filter[field] = Array.isArray(value) ? value.map(String) : [String(value)];
  }
  return Object.keys(filter).length ? filter : undefined;
}

export async function savePlan(input: TestPlanInput): Promise<TestPlan[]> {
  const id = input.id.trim();
  if (!id) throw new Error("A plan needs an id.");
  if (!input.name.trim()) throw new Error("A plan needs a name.");
  const root = plansRoot();
  await mkdir(root, { recursive: true });
  const body = {
    id,
    name: input.name.trim(),
    ...(input.description ? { description: input.description } : {}),
    ...(input.filter && Object.keys(input.filter).length ? { filter: input.filter } : {}),
    ...(input.columns?.length ? { columns: input.columns } : {}),
    ...(input.refs?.length ? { refs: input.refs } : {}),
  };
  await writeFile(path.join(root, `${id}.yaml`), stringifyYaml(body, { lineWidth: 0 }), "utf8");
  if (input.previousId && input.previousId !== id) {
    await rm(path.join(root, `${input.previousId}.yaml`), { force: true });
  }
  return listPlans();
}

export async function deletePlan(id: string): Promise<TestPlan[]> {
  await rm(path.join(plansRoot(), `${id}.yaml`), { force: true });
  return listPlans();
}

/** The cases a plan selects: explicit refs in order, else everything matching its filter. */
export function resolvePlan(plan: TestPlan, cases: Case[]): Case[] {
  if (plan.refs?.length) {
    const byRef = new Map(cases.map((c) => [c.ref, c]));
    return plan.refs.map((ref) => byRef.get(ref)).filter((c): c is Case => Boolean(c));
  }
  // A filter matches on custom fields, plus `tags` for Qase's flat tag list.
  return cases.filter((c) =>
    Object.entries(plan.filter ?? {}).every(([field, values]) =>
      values.some((v) => (field === "tags" ? c.tags : (c.custom_fields[field] ?? [])).includes(v)),
    ),
  );
}

/** Everything a plan run will execute: one entry per case per covered column. */
export function planEntries(plan: TestPlan, cases: Case[]): PlanRunEntry[] {
  const entries: PlanRunEntry[] = [];
  for (const c of resolvePlan(plan, cases)) {
    const columns = Object.entries(c.conductor?.flows ?? {})
      .filter(([column]) => !plan.columns?.length || plan.columns.includes(column))
      .map(([column, flow]) => ({ column, flow }));
    if (c.conductor?.flow && !columns.length) columns.push({ column: "", flow: c.conductor.flow });
    if (!columns.length) {
      entries.push({ ref: c.ref, title: c.title, status: "skipped" });
      continue;
    }
    for (const { column, flow } of columns) {
      entries.push({ ref: c.ref, title: c.title, column: column || undefined, flow, status: "pending" });
    }
  }
  return entries;
}

// ── Execution ───────────────────────────────────────────────────────────────

/** `DEMO-12` -> 12. Results carry both, so a re-coded project still resolves. */
function caseIdFor(ref: string): number {
  return Number(ref.slice(ref.lastIndexOf("-") + 1)) || 0;
}

const runs = new Map<string, PlanRun>();
const cancelled = new Set<string>();
let seed = 0;

export function listPlanRuns(): PlanRun[] {
  return [...runs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function cancelPlanRun(id: string): void {
  cancelled.add(id);
  // Stop the flow that is on the device right now, not just the queue behind it.
  const active = runs.get(id)?.entries.find((e) => e.status === "running");
  if (active?.runId) cancelRun(active.runId);
}

/** Run every case in a plan, in order, on one device. */
export async function startPlanRun(planId: string, deviceId?: string): Promise<PlanRun> {
  const plan = (await listPlans()).find((p) => p.id === planId);
  if (!plan) throw new Error(`No plan with id "${planId}".`);
  const cases = await listCases();
  seed += 1;
  const run: PlanRun = {
    id: `plan-${Date.now()}-${seed}`,
    planId: plan.id,
    planName: plan.name,
    startedAt: Date.now(),
    status: "running",
    deviceId,
    entries: planEntries(plan, cases),
  };
  runs.set(run.id, run);
  broadcastToRenderers("plans:run-updated", run);
  void execute(run);
  return run;
}

async function execute(run: PlanRun): Promise<void> {
  const publish = () => broadcastToRenderers("plans:run-updated", { ...run, entries: [...run.entries] });
  for (const entry of run.entries) {
    if (cancelled.has(run.id)) break;
    if (!entry.flow) {
      // A case with no automation still belongs in the plan — it just needs a
      // person, so say so instead of pretending it ran.
      await recordResult({
        case_id: caseIdFor(entry.ref),
        ref: entry.ref,
        column: entry.column,
        status: "skipped",
        source: "run",
        plan_run_id: run.id,
        comment: "No flow implements this case yet.",
      });
      continue;
    }
    entry.status = "running";
    publish();
    try {
      const { runId } = await runFlow(entry.flow, run.deviceId, undefined, entry.column);
      // The run's own completion hook files the case result; tell it which plan
      // execution to attribute it to rather than recording it twice here.
      claimRunForPlan(runId, run.id);
      entry.runId = runId;
      publish();
      const status = await awaitRun(runId);
      entry.status = status === "passed" ? "passed" : status === "cancelled" ? "skipped" : "failed";
    } catch (e) {
      entry.status = "failed";
      await recordResult({
        case_id: caseIdFor(entry.ref),
        ref: entry.ref,
        column: entry.column,
        status: "failed",
        source: "run",
        plan_run_id: run.id,
        flow: entry.flow,
        comment: String(e),
      });
    }
    publish();
  }
  run.finishedAt = Date.now();
  run.status = cancelled.has(run.id)
    ? "cancelled"
    : run.entries.some((e) => e.status === "failed")
      ? "failed"
      : "passed";
  cancelled.delete(run.id);
  publish();
}
