import type { CiSync, FlowRunStatus } from "../../../app/lib/types";
import { broadcastToRenderers } from "../../broadcast";
import { getProjectInfo } from "../file/fileService";
import { run, which } from "../util/exec";

/**
 * CI status for test cases, read from GitHub Actions via the `gh` CLI (which
 * already carries the user's auth). A case matches the job that exercises it:
 * by case id (`TC-001`) or by the flow file it points at, both looked up in the
 * job name — so `run TC-001 login` and `maestro login.yaml` both bind.
 */

let cache: CiSync | null = null;

export function getCiSync(): CiSync | null {
  return cache;
}

export function getCiStatuses(): Record<string, FlowRunStatus> {
  return cache?.statuses ?? {};
}

interface GhRun {
  databaseId: number;
  displayTitle?: string;
  workflowName?: string;
  headBranch?: string;
  status?: string;
  conclusion?: string;
  url?: string;
  createdAt?: string;
}

interface GhJob {
  name: string;
  status?: string;
  conclusion?: string;
}

export async function syncCi(cases: { id: string; flow?: string }[]): Promise<CiSync> {
  const project = getProjectInfo();
  if (!project) throw new Error("No project is open.");
  if (!(await which("gh"))) {
    throw new Error("GitHub CLI (`gh`) not found — install it and run `gh auth login` to sync CI.");
  }

  const latest = await latestRun(project.root);
  if (!latest) throw new Error("No GitHub Actions runs found for this repository.");
  const jobs = await runJobs(project.root, latest.databaseId);

  // With no job-level detail to match against, the run's own result is the best
  // signal we have — flagged so the UI can say the status isn't per-case.
  const fallback = jobs.length === 0;
  const statuses: Record<string, FlowRunStatus> = {};
  for (const c of cases) {
    const job = jobs.find((j) => jobMatchesCase(j.name, c.id, c.flow));
    const source = job ?? (fallback ? latest : null);
    if (source) statuses[c.id] = toStatus(source.status, source.conclusion);
  }

  cache = {
    repo: latest.url ? repoFromUrl(latest.url) : undefined,
    runUrl: latest.url,
    runName: latest.workflowName ?? latest.displayTitle,
    branch: latest.headBranch,
    syncedAt: Date.now(),
    matched: Object.keys(statuses).length,
    total: cases.length,
    fallbackToRunStatus: fallback,
    statuses,
  };
  broadcastToRenderers("cases:ci-synced", cache);
  return cache;
}

async function latestRun(cwd: string): Promise<GhRun | null> {
  const res = await run(
    "gh",
    [
      "run",
      "list",
      "--limit",
      "1",
      "--json",
      "databaseId,displayTitle,workflowName,headBranch,status,conclusion,url,createdAt",
    ],
    { cwd, timeout: 30_000 },
  );
  if (res.code !== 0) throw new Error(res.stderr.trim() || "gh run list failed");
  const rows = safeJson<GhRun[]>(res.stdout) ?? [];
  return rows[0] ?? null;
}

async function runJobs(cwd: string, runId: number): Promise<GhJob[]> {
  const res = await run("gh", ["run", "view", String(runId), "--json", "jobs"], {
    cwd,
    timeout: 30_000,
  });
  if (res.code !== 0) return [];
  return safeJson<{ jobs?: GhJob[] }>(res.stdout)?.jobs ?? [];
}

/** A job belongs to a case when its name mentions the case id or its flow file. */
function jobMatchesCase(jobName: string, caseId: string, flow?: string): boolean {
  const name = jobName.toLowerCase();
  if (caseId && name.includes(caseId.toLowerCase())) return true;
  if (!flow) return false;
  const base = flow.split("/").pop() ?? flow;
  return name.includes(base.toLowerCase()) || name.includes(base.replace(/\.[^.]+$/, "").toLowerCase());
}

function toStatus(status?: string, conclusion?: string): FlowRunStatus {
  if (status && status !== "completed") return "running";
  switch (conclusion) {
    case "success":
      return "passed";
    case "cancelled":
      return "cancelled";
    case "failure":
    case "timed_out":
      return "failed";
    default:
      return "error";
  }
}

function repoFromUrl(url: string): string | undefined {
  const m = /github\.com\/([^/]+\/[^/]+)/.exec(url);
  return m?.[1];
}

function safeJson<T>(text: string): T | null {
  try {
    return JSON.parse(text.trim()) as T;
  } catch {
    return null;
  }
}
