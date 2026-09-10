/**
 * Compare two recorded parity runs, checkpoint by checkpoint.
 *
 * Checkpoints pair up by *name*, not by index: a candidate that inserts an extra
 * checkpoint still lines up with the reference, and one the candidate never
 * reached is reported as such rather than silently shifting everything after it.
 */
import fs from 'fs';
import path from 'path';
import {
  CheckpointDiff,
  DEFAULT_DIFF_OPTIONS,
  DiffOptions,
  diffCheckpoint,
  missingCheckpoint,
} from './diff.js';
import { comparePng } from './pixel.js';
import { loadRun, RunManifest, slugify } from './store.js';

export interface ParityReport {
  version: 1;
  passed: boolean;
  comparedAt: string;
  reference: { dir: string; manifest: RunManifest };
  candidate: { dir: string; manifest: RunManifest };
  options: DiffOptions;
  summary: {
    checkpoints: number;
    passed: number;
    failed: number;
    blocking: number;
    advisory: number;
  };
  checkpoints: CheckpointDiff[];
}

export interface CompareOptions extends Partial<DiffOptions> {
  /** Directory for diff images. Defaults to the candidate run directory. */
  diffDir?: string;
}

export function compareRuns(
  referenceDir: string,
  candidateDir: string,
  options: CompareOptions = {}
): ParityReport {
  const refDir = path.resolve(referenceDir);
  const candDir = path.resolve(candidateDir);
  const reference = loadRun(refDir);
  const candidate = loadRun(candDir);

  const resolved: DiffOptions = { ...DEFAULT_DIFF_OPTIONS, ...stripUndefined(options) };
  const diffDir = path.resolve(options.diffDir ?? candDir);
  fs.mkdirSync(diffDir, { recursive: true });

  const candByName = new Map(candidate.checkpoints.map((c) => [c.snapshot.name, c]));
  const results: CheckpointDiff[] = [];

  for (const refCp of reference.checkpoints) {
    const name = refCp.snapshot.name;
    const candCp = candByName.get(name);
    if (!candCp) {
      results.push(missingCheckpoint(name, resolved));
      continue;
    }
    candByName.delete(name);

    const pixel = comparePng(refCp.screenshotPath, candCp.screenshotPath, {
      threshold: resolved.pixelThreshold,
      diffPath: path.join(diffDir, `${slugify(name)}.diff.png`),
    });

    results.push(
      diffCheckpoint(
        {
          name,
          reference: {
            a11ySnapshot: refCp.snapshot.a11ySnapshot,
            width: refCp.snapshot.device.width,
            height: refCp.snapshot.device.height,
            platform: refCp.snapshot.device.platform,
          },
          candidate: {
            a11ySnapshot: candCp.snapshot.a11ySnapshot,
            width: candCp.snapshot.device.width,
            height: candCp.snapshot.device.height,
            platform: candCp.snapshot.device.platform,
          },
          pixel,
        },
        resolved
      )
    );
  }

  // Checkpoints only the candidate reached are worth surfacing, but they can't
  // be compared against anything — report them as advisory extras.
  for (const [name, cp] of candByName) {
    results.push({
      name,
      passed: true,
      scaled: false,
      rolesRelaxed: false,
      counts: { added: cp.snapshot.a11ySnapshot.length },
      findings: [
        {
          kind: 'added',
          severity: 'advisory',
          detail: `the candidate recorded checkpoint "${name}", which the reference run does not have`,
        },
      ],
    });
  }

  const blocking = results.reduce(
    (n, c) => n + c.findings.filter((f) => f.severity === 'blocking').length,
    0
  );
  const advisory = results.reduce(
    (n, c) => n + c.findings.filter((f) => f.severity === 'advisory').length,
    0
  );

  return {
    version: 1,
    passed: results.every((c) => c.passed),
    comparedAt: new Date().toISOString(),
    reference: { dir: refDir, manifest: reference.manifest },
    candidate: { dir: candDir, manifest: candidate.manifest },
    options: resolved,
    summary: {
      checkpoints: results.length,
      passed: results.filter((c) => c.passed).length,
      failed: results.filter((c) => !c.passed).length,
      blocking,
      advisory,
    },
    checkpoints: results,
  };
}

/**
 * Drop explicitly-undefined keys so an unset CLI flag falls through to the
 * default rather than overwriting it with `undefined`.
 */
function stripUndefined(opts: CompareOptions): Partial<DiffOptions> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(opts)) {
    if (k === 'diffDir' || v === undefined) continue;
    out[k] = v;
  }
  return out as Partial<DiffOptions>;
}
