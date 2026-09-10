/**
 * Parity runs: one reference build, many targets, all at once.
 *
 * Studio drives the fan-out itself rather than handing the whole job to
 * `conductor parity compare --target …`. Two reasons: it needs a live device
 * stream per target while the walk happens, and it needs per-target progress to
 * light up the grid as checkpoints land. So each target gets its own
 * `parity record` child process (which is also what keeps the `checkpoint`
 * step's process-wide active run isolated), and the diff is done afterwards by
 * `parity matrix`, which needs no devices at all.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type {
  ParityMatrix,
  ParityProgress,
  ParityRunRequest,
  ParityRunStarted,
  ParityTarget,
  ParityTargetProgress,
} from "../../../app/lib/types";
import { broadcastToRenderers } from "../../broadcast";
import { appState } from "../../state";
import { resolveConductor } from "../maestro/maestroService";
import { slugCollision, slugForLabel } from "./labels";

interface ActiveRun {
  runId: string;
  outDir: string;
  referenceDir: string;
  children: Set<ChildProcess>;
  cancelled: boolean;
  progress: ParityProgress;
}

let active: ActiveRun | null = null;

export function getParityRun(): ParityProgress | null {
  return active?.progress ?? null;
}

function publish(run: ActiveRun): void {
  // Structured-clone the payload: the renderer gets a snapshot, not a live
  // reference we keep mutating underneath it.
  broadcastToRenderers("parity_progress", JSON.parse(JSON.stringify(run.progress)));
}

function tick(run: ActiveRun, mutate: (p: ParityProgress) => void): void {
  mutate(run.progress);
  publish(run);
}

/** Locate a target's progress slot, or the reference's. */
function slotFor(p: ParityProgress, label: string): ParityTargetProgress | undefined {
  if (p.reference.label === label) return p.reference;
  return p.targets.find((t) => t.label === label);
}

async function conductorArgs(): Promise<{ bin: string; prefix: string[]; env: NodeJS.ProcessEnv }> {
  const resolved = await resolveConductor();
  if (!resolved) {
    throw new Error(
      "Bundled conductor CLI is missing. Run `pnpm prepare-conductor` in apps/studio, or pick a different version in Settings.",
    );
  }
  return { bin: resolved.bin, prefix: resolved.prefixArgs, env: resolved.env };
}

/**
 * Walk one build, streaming progress.
 *
 * `parity record` prints a line per captured checkpoint, which is what the grid
 * counts — parsing stdout keeps the CLI free of a Studio-shaped progress
 * protocol, and a line it doesn't recognise is simply not progress.
 */
function recordOne(
  run: ActiveRun,
  opts: {
    label: string;
    deviceId: string;
    flowPath: string;
    outDir: string;
    role: "reference" | "candidate";
    bin: string;
    prefix: string[];
    env: NodeJS.ProcessEnv;
  },
): Promise<{ ok: boolean; output: string }> {
  const args = [
    ...opts.prefix,
    "parity",
    "record",
    opts.flowPath,
    "--out",
    opts.outDir,
    "--device",
    opts.deviceId,
    "--label",
    opts.label,
    "--role",
    opts.role,
  ];

  return new Promise((resolve) => {
    const child = spawn(opts.bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env,
      cwd: appState.projectRoot ?? process.cwd(),
    });
    run.children.add(child);

    let output = "";
    const onChunk = (chunk: Buffer): void => {
      const text = chunk.toString();
      output += text;
      // `  checkpoint "cart" — captured`
      for (const m of text.matchAll(/checkpoint "([^"]+)"\s+[—-]\s+captured/g)) {
        tick(run, (p) => {
          const slot = slotFor(p, opts.label);
          if (!slot) return;
          slot.checkpoints += 1;
          slot.lastCheckpoint = m[1];
        });
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);

    child.on("close", (code) => {
      run.children.delete(child);
      resolve({ ok: code === 0, output });
    });
    child.on("error", (err) => {
      run.children.delete(child);
      resolve({ ok: false, output: err.message });
    });
  });
}

/** Diff every recorded target against the reference. No devices involved. */
async function diffMatrix(
  run: ActiveRun,
  targets: ParityTarget[],
  cli: { bin: string; prefix: string[]; env: NodeJS.ProcessEnv },
): Promise<ParityMatrix> {
  const jsonPath = path.join(run.outDir, "parity-matrix.json");
  const dirs = targets.map((t) => path.join(run.outDir, "targets", slugForLabel(t.label)));
  const args = [
    ...cli.prefix,
    "parity",
    "matrix",
    run.referenceDir,
    ...dirs,
    "--json-report",
    jsonPath,
    "--html",
    path.join(run.outDir, "parity-matrix.html"),
  ];

  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(cli.bin, args, { stdio: ["ignore", "pipe", "pipe"], env: cli.env });
    run.children.add(child);
    let buf = "";
    child.stdout?.on("data", (c: Buffer) => (buf += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (buf += c.toString()));
    // A non-zero exit here means "targets differ", which is a result, not a
    // failure — the matrix on disk is what we actually want either way.
    child.on("close", () => {
      run.children.delete(child);
      resolve(buf);
    });
    child.on("error", (err) => {
      run.children.delete(child);
      reject(err);
    });
  });

  try {
    return JSON.parse(await readFile(jsonPath, "utf-8")) as ParityMatrix;
  } catch (err) {
    throw new Error(
      `parity matrix produced no report at ${jsonPath}: ${
        err instanceof Error ? err.message : String(err)
      }\n${output.trim()}`,
    );
  }
}

/**
 * Record the reference (unless one is being reused), walk every target in
 * parallel, then diff. Returns as soon as the run is under way; everything
 * after that arrives on `parity_progress`.
 */
export async function startParityRun(req: ParityRunRequest): Promise<ParityRunStarted> {
  if (active && active.progress.phase !== "done" && active.progress.phase !== "failed") {
    throw new Error("a parity run is already in progress");
  }
  if (req.targets.length === 0) throw new Error("a parity run needs at least one target");

  const dupes = req.targets.map((t) => t.label).filter((l, i, a) => a.indexOf(l) !== i);
  if (dupes.length) throw new Error(`target names must be unique — "${dupes[0]}" is used twice`);

  const collision = slugCollision(req.targets.map((t) => t.label));
  if (collision) {
    throw new Error(
      `target names "${collision.a}" and "${collision.b}" are too alike — ` +
        `both become "${collision.slug}" on disk`,
    );
  }

  const cli = await conductorArgs();
  const runId = randomUUID();
  const root = appState.projectRoot ?? process.cwd();
  const outDir = path.join(root, ".conductor", "parity", runId);
  const referenceDir = req.reuseReferenceDir ?? path.join(outDir, "reference");
  await mkdir(path.join(outDir, "targets"), { recursive: true });

  const run: ActiveRun = {
    runId,
    outDir,
    referenceDir,
    children: new Set(),
    cancelled: false,
    progress: {
      runId,
      phase: req.reuseReferenceDir ? "walking-targets" : "recording-reference",
      reference: {
        label: req.referenceLabel,
        deviceId: req.referenceDeviceId,
        phase: req.reuseReferenceDir ? "recorded" : "idle",
        checkpoints: 0,
      },
      targets: req.targets.map((t) => ({
        label: t.label,
        deviceId: t.deviceId,
        phase: "idle" as const,
        checkpoints: 0,
      })),
    },
  };
  active = run;
  publish(run);

  // Kick the work off without blocking the IPC reply, so the renderer can put
  // the streams up while the first checkpoints are still being captured.
  void execute(run, req, cli).catch((err: unknown) => {
    tick(run, (p) => {
      p.phase = "failed";
      p.error = err instanceof Error ? err.message : String(err);
    });
  });

  return { runId, outDir, referenceDir };
}

async function execute(
  run: ActiveRun,
  req: ParityRunRequest,
  cli: { bin: string; prefix: string[]; env: NodeJS.ProcessEnv },
): Promise<void> {
  // ── 1. The reference, on its own, first ──
  //
  // Recorded before the targets rather than alongside them: it is the contract
  // the targets are held to, and a reference that failed to walk makes every
  // target's result meaningless, so there is no point spending four devices to
  // find that out.
  if (!req.reuseReferenceDir) {
    tick(run, (p) => {
      p.phase = "recording-reference";
      p.reference.phase = "walking";
    });
    const res = await recordOne(run, {
      label: req.referenceLabel,
      deviceId: req.referenceDeviceId,
      flowPath: req.flowPath,
      outDir: run.referenceDir,
      role: "reference",
      ...cli,
    });
    if (run.cancelled) return;
    if (!res.ok) {
      tick(run, (p) => {
        p.phase = "failed";
        p.reference.phase = "failed";
        p.reference.error = res.output.trim();
        p.error = `the reference build failed to walk the flow — nothing to compare against`;
      });
      return;
    }
    tick(run, (p) => {
      p.reference.phase = "recorded";
    });
  }

  // ── 2. Every target at once ──
  tick(run, (p) => {
    p.phase = "walking-targets";
    for (const t of p.targets) t.phase = "walking";
  });

  const results = await Promise.all(
    req.targets.map(async (t) => {
      const res = await recordOne(run, {
        label: t.label,
        deviceId: t.deviceId,
        flowPath: req.flowPath,
        outDir: path.join(run.outDir, "targets", slugForLabel(t.label)),
        role: "candidate",
        ...cli,
      });
      tick(run, (p) => {
        const slot = slotFor(p, t.label);
        if (!slot) return;
        slot.phase = res.ok ? "recorded" : "failed";
        if (!res.ok) slot.error = res.output.trim();
      });
      return { target: t, ...res };
    }),
  );

  if (run.cancelled) return;

  // ── 3. Diff whatever walked ──
  //
  // A target that never recorded is dropped from the diff rather than failing
  // the whole run: with four targets, one device dying shouldn't cost you the
  // other three's results. Its tile stays marked failed, so the grid can't be
  // mistaken for a clean sweep.
  const walked = results.filter((r) => r.ok).map((r) => r.target);
  if (walked.length === 0) {
    tick(run, (p) => {
      p.phase = "failed";
      p.error = "no target finished its walk";
    });
    return;
  }

  tick(run, (p) => {
    p.phase = "diffing";
  });
  const matrix = await diffMatrix(run, walked, cli);
  if (run.cancelled) return;
  tick(run, (p) => {
    p.phase = "done";
    p.matrix = matrix;
  });
}

export function cancelParityRun(): void {
  if (!active) return;
  active.cancelled = true;
  for (const child of active.children) child.kill();
  active.children.clear();
  tick(active, (p) => {
    p.phase = "failed";
    p.error = "cancelled";
    for (const t of [p.reference, ...p.targets]) {
      if (t.phase === "walking") t.phase = "failed";
    }
  });
}

/** Re-diff an existing run's directories — free, so thresholds can be re-tuned. */
export async function rediffParityRun(
  referenceDir: string,
  targetDirs: string[],
): Promise<ParityMatrix> {
  const cli = await conductorArgs();
  const jsonPath = path.join(path.dirname(referenceDir), "parity-matrix.json");
  const args = [
    ...cli.prefix,
    "parity",
    "matrix",
    referenceDir,
    ...targetDirs,
    "--json-report",
    jsonPath,
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cli.bin, args, { stdio: ["ignore", "ignore", "pipe"], env: cli.env });
    let err = "";
    child.stderr?.on("data", (c: Buffer) => (err += c.toString()));
    child.on("close", () => resolve());
    child.on("error", () => reject(new Error(err || "parity matrix failed")));
  });
  return JSON.parse(await readFile(jsonPath, "utf-8")) as ParityMatrix;
}
