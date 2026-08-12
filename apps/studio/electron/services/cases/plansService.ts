import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type {
  PlanRun,
  PlanRunEntry,
  TestCase,
  TestPlan,
  TestPlanInput,
} from "../../../app/lib/types";
import { broadcastToRenderers } from "../../broadcast";
import { getProjectInfo } from "../file/fileService";
import { studioDir } from "../util/studioPaths";
import { awaitRun, cancelRun, runFlow } from "../flow/flowRunner";
import { listCases } from "./casesService";
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

function plansRoot(): string {
  const project = getProjectInfo();
  if (!project) throw new Error("No project is open.");
  return studioDir("plans", project.root);
}

export async function listPlans(): Promise<TestPlan[]> {
  const root = plansRoot();
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
        caseIds: Array.isArray(raw.caseIds) ? raw.caseIds.map(String) : undefined,
        filter: normalizeFilter(raw.filter),
        columns: Array.isArray(raw.columns) ? raw.columns.map(String) : undefined,
        filePath: abs,
      });
    } catch {
      // skip malformed plans
    }
  }
  return plans.sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeFilter(raw: unknown): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const filter: Record<string, string[]> = {};
  for (const [dim, value] of Object.entries(raw as Record<string, unknown>)) {
    filter[dim] = Array.isArray(value) ? value.map(String) : [String(value)];
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
    ...(input.caseIds?.length ? { caseIds: input.caseIds } : {}),
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

/** The cases a plan selects: explicit ids in order, else everything matching its filter. */
export function resolvePlan(plan: TestPlan, cases: TestCase[]): TestCase[] {
  if (plan.caseIds?.length) {
    const byId = new Map(cases.map((c) => [c.id, c]));
    return plan.caseIds.map((id) => byId.get(id)).filter((c): c is TestCase => Boolean(c));
  }
  return cases.filter((c) =>
    Object.entries(plan.filter ?? {}).every(([dim, values]) =>
      values.some((v) => (c.tags[dim] ?? []).includes(v)),
    ),
  );
}

/** Everything a plan run will execute: one entry per case per covered column. */
export function planEntries(plan: TestPlan, cases: TestCase[]): PlanRunEntry[] {
  const entries: PlanRunEntry[] = [];
  for (const c of resolvePlan(plan, cases)) {
    const columns = Object.entries(c.flows ?? {})
      .filter(([column]) => !plan.columns?.length || plan.columns.includes(column))
      .map(([column, flow]) => ({ column, flow }));
    if (c.flow && !columns.length) columns.push({ column: "", flow: c.flow });
    if (!columns.length) {
      entries.push({ caseId: c.id, title: c.title, status: "skipped" });
      continue;
    }
    for (const { column, flow } of columns) {
      entries.push({ caseId: c.id, title: c.title, column: column || undefined, flow, status: "pending" });
    }
  }
  return entries;
}

// ── Execution ───────────────────────────────────────────────────────────────

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
        caseId: entry.caseId,
        column: entry.column,
        verdict: "skipped",
        source: "run",
        planRunId: run.id,
        note: "No flow implements this case yet.",
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
        caseId: entry.caseId,
        column: entry.column,
        verdict: "failed",
        source: "run",
        planRunId: run.id,
        flow: entry.flow,
        note: String(e),
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
