/**
 * Parity run storage.
 *
 * A *run* is one walk of a journey through one build of an app, with a capture
 * taken at each named checkpoint. Two runs of the same journey — one against the
 * reference build, one against the candidate — are what `parity diff` compares.
 *
 * On disk:
 *
 *   <run-dir>/
 *     run.json                 manifest: role, flow, device, screen size, checkpoint list
 *     <slug>.json              per-checkpoint a11y snapshot
 *     <slug>.png               per-checkpoint screenshot
 *
 * The view hierarchy is deliberately not stored: the a11y snapshot carries the
 * label/role/frame/value/state the diff actually reads, and hierarchies are
 * large enough to make a run directory unpleasant to keep in a repo.
 */
import fs from 'fs';
import path from 'path';
import type { A11ySnapshotEntry } from '../drivers/a11y.js';
import type { CapturePlatform, ScreenCapture } from './capture.js';

export const RUN_MANIFEST = 'run.json';

export type RunRole = 'reference' | 'candidate';

export interface CheckpointRecord {
  name: string;
  /** Position in the journey. Checkpoints are compared by name, not by index. */
  index: number;
  capturedAt: string;
  /** Basenames within the run directory. */
  snapshotFile: string;
  screenshotFile: string;
}

export interface RunManifest {
  version: 1;
  role: RunRole;
  /** Flow file this run walked, when it came from one. */
  flow?: string;
  label?: string;
  appId?: string;
  device: {
    platform: CapturePlatform;
    deviceId: string;
    width: number;
    height: number;
  };
  startedAt: string;
  finishedAt?: string;
  checkpoints: CheckpointRecord[];
}

export interface CheckpointSnapshot {
  version: 1;
  name: string;
  capturedAt: string;
  device: {
    platform: CapturePlatform;
    deviceId: string;
    width: number;
    height: number;
  };
  a11ySnapshot: A11ySnapshotEntry[];
}

/** A checkpoint loaded off disk, with its screenshot. */
export interface LoadedCheckpoint {
  record: CheckpointRecord;
  snapshot: CheckpointSnapshot;
  screenshotPath: string;
}

/** Filesystem-safe, stable, readable name for a checkpoint. */
export function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'checkpoint';
}

// ── Writing ──────────────────────────────────────────────────────────────────

/**
 * An open run being written to. Checkpoints append as the journey proceeds, so
 * a run interrupted mid-journey still leaves everything captured so far on disk
 * (and `diff` reports the checkpoints that were never reached).
 */
export class RunWriter {
  private readonly manifest: RunManifest;
  private readonly usedSlugs = new Set<string>();

  constructor(
    readonly dir: string,
    init: {
      role: RunRole;
      deviceId: string;
      flow?: string;
      label?: string;
      appId?: string;
    },
    /** Manifest to continue instead of starting fresh — see `RunWriter.open`. */
    resume?: RunManifest
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.manifest = resume ?? {
      version: 1,
      role: init.role,
      flow: init.flow,
      label: init.label,
      appId: init.appId,
      // Filled in from the first capture — the driver is the authority on screen size.
      device: { platform: 'ios', deviceId: init.deviceId, width: 0, height: 0 },
      startedAt: new Date().toISOString(),
      checkpoints: [],
    };
    for (const cp of this.manifest.checkpoints) {
      this.usedSlugs.add(cp.snapshotFile.replace(/\.json$/, ''));
    }
    this.flush();
  }

  /**
   * Reattach to a run directory an earlier process created, so checkpoints
   * appended from a separate `conductor checkpoint` invocation continue the
   * same run instead of restarting it.
   */
  static open(dir: string): RunWriter {
    const resolved = path.resolve(dir);
    const existing = loadManifest(resolved);
    return new RunWriter(
      resolved,
      { role: existing.role, deviceId: existing.device.deviceId },
      existing
    );
  }

  get checkpointCount(): number {
    return this.manifest.checkpoints.length;
  }

  /** Persist one checkpoint. Duplicate names get a numeric suffix rather than overwriting. */
  add(name: string, capture: ScreenCapture): CheckpointRecord {
    let slug = slugify(name);
    if (this.usedSlugs.has(slug)) {
      let n = 2;
      while (this.usedSlugs.has(`${slug}-${n}`)) n++;
      slug = `${slug}-${n}`;
    }
    this.usedSlugs.add(slug);

    const capturedAt = new Date().toISOString();
    const device = {
      platform: capture.platform,
      deviceId: this.manifest.device.deviceId,
      width: capture.width,
      height: capture.height,
    };
    this.manifest.device = device;

    const snapshot: CheckpointSnapshot = {
      version: 1,
      name,
      capturedAt,
      device,
      a11ySnapshot: capture.a11ySnapshot,
    };

    const snapshotFile = `${slug}.json`;
    const screenshotFile = `${slug}.png`;
    fs.writeFileSync(path.join(this.dir, snapshotFile), JSON.stringify(snapshot, null, 2));
    fs.writeFileSync(path.join(this.dir, screenshotFile), capture.screenshot);

    const record: CheckpointRecord = {
      name,
      index: this.manifest.checkpoints.length,
      capturedAt,
      snapshotFile,
      screenshotFile,
    };
    this.manifest.checkpoints.push(record);
    this.flush();
    return record;
  }

  finish(): RunManifest {
    this.manifest.finishedAt = new Date().toISOString();
    this.flush();
    return this.manifest;
  }

  private flush(): void {
    fs.writeFileSync(
      path.join(this.dir, RUN_MANIFEST),
      JSON.stringify(this.manifest, null, 2) + '\n'
    );
  }
}

// ── The ambient run ──────────────────────────────────────────────────────────

/**
 * The run that `checkpoint` steps write into.
 *
 * `parity record` / `parity compare` execute the flow in-process, so a module
 * singleton is enough for them. The env var covers the out-of-process case: a
 * `conductor checkpoint` invoked from `run-sequence` or a shell script still
 * lands in the same run.
 */
export const PARITY_RUN_ENV = 'CONDUCTOR_PARITY_RUN';

let activeRun: RunWriter | null = null;

export function setActiveRun(run: RunWriter | null): void {
  activeRun = run;
  if (run) process.env[PARITY_RUN_ENV] = run.dir;
  else delete process.env[PARITY_RUN_ENV];
}

export function getActiveRun(): RunWriter | null {
  return activeRun;
}

/**
 * Resolve the run a checkpoint should be written to: the in-process one, else
 * whatever `CONDUCTOR_PARITY_RUN` points at, else null (nothing is recording).
 */
export function resolveActiveRun(explicitDir?: string): RunWriter | null {
  if (explicitDir) return RunWriter.open(explicitDir);
  if (activeRun) return activeRun;
  const fromEnv = process.env[PARITY_RUN_ENV];
  return fromEnv ? RunWriter.open(fromEnv) : null;
}

// ── Reading ──────────────────────────────────────────────────────────────────

export function loadManifest(dir: string): RunManifest {
  const manifestPath = path.join(path.resolve(dir), RUN_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`not a parity run directory (no ${RUN_MANIFEST}): ${path.resolve(dir)}`);
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as RunManifest;
}

export function loadRun(dir: string): { manifest: RunManifest; checkpoints: LoadedCheckpoint[] } {
  const resolved = path.resolve(dir);
  const manifest = loadManifest(resolved);
  const checkpoints = manifest.checkpoints.map((record) => {
    const snapshotPath = path.join(resolved, record.snapshotFile);
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8')) as CheckpointSnapshot;
    return {
      record,
      snapshot,
      screenshotPath: path.join(resolved, record.screenshotFile),
    };
  });
  return { manifest, checkpoints };
}
