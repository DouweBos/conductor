/**
 * One reference, many targets.
 *
 * A port rarely goes to one place. The same screen gets rebuilt for tvOS,
 * Android TV, Vega and a Lightning web build, and each of those is asked the
 * same question: does it still match the reference? Running N separate
 * two-way comparisons answers that N times over, but throws away the thing only
 * the full set can tell you —
 *
 *   a finding on **one** target is that target's bug;
 *   a finding on **every** target is a signal about the *reference*.
 *
 * If every rebuild is missing the same button, the likelier explanation is that
 * the reference run captured something the product no longer has (a stale
 * recording, a feature flag, an A/B bucket) than that four independent teams
 * dropped the same control. So this module diffs each target against the
 * reference and then rolls the findings up across targets, marking the ones
 * that are universal.
 */
import path from 'path';
import { compareRuns, CompareOptions, ParityReport } from './compare.js';
import type { Finding, FindingKind, Severity } from './diff.js';
import { loadManifest, RunManifest } from './store.js';

/** A build to check the reference against. */
export interface TargetSpec {
  /** Short name for the column: "tvOS", "Android TV", "VegaOS", "Lightning". */
  label: string;
  dir: string;
}

export interface TargetResult {
  label: string;
  dir: string;
  manifest: RunManifest;
  platform: string;
  passed: boolean;
  report: ParityReport;
}

/** One cell of the checkpoint × target grid. */
export interface MatrixCell {
  target: string;
  /** `absent` when this target's run never recorded the checkpoint at all. */
  status: 'pass' | 'fail' | 'absent';
  blocking: number;
  advisory: number;
}

export interface MatrixRow {
  checkpoint: string;
  cells: MatrixCell[];
  /** True when every target passes this checkpoint. */
  passed: boolean;
}

/**
 * The same finding seen across one or more targets.
 *
 * Grouped by what the finding is *about* — the element's identity and the kind
 * of divergence — rather than by its prose, so the same dropped button on four
 * platforms collapses into one row.
 */
export interface SharedFinding {
  signature: string;
  checkpoint: string;
  kind: FindingKind;
  severity: Severity;
  /** Best available name for the element: its identifier, else its label. */
  subject: string;
  role?: string;
  identifier?: string;
  /** Labels of the targets reporting it. */
  targets: string[];
  /**
   * True when every target reports it. Read this as a question about the
   * reference, not about the targets.
   */
  universal: boolean;
  /** One target's wording, as an example. */
  detail: string;
}

export interface ParityMatrix {
  version: 1;
  passed: boolean;
  comparedAt: string;
  reference: { dir: string; label: string; manifest: RunManifest };
  targets: TargetResult[];
  /** Checkpoint × target grid, in reference order. */
  rows: MatrixRow[];
  /** Findings rolled up across targets, universal ones first. */
  shared: SharedFinding[];
  summary: {
    targets: number;
    targetsPassed: number;
    checkpoints: number;
    blocking: number;
    advisory: number;
    /** Findings every target reports — candidates for a stale reference. */
    universal: number;
  };
}

/** Group findings by what they are about, not by how they are worded. */
export function findingSignature(checkpoint: string, f: Finding): string {
  const subject = (f.identifier || f.label || '').trim().toLowerCase();
  return [checkpoint, f.kind, subject, (f.role ?? '').trim().toLowerCase()].join('|');
}

function subjectOf(f: Finding): string {
  return (f.identifier || f.label || '').trim();
}

/** Diff every target against one reference and roll the results up. */
export function buildMatrix(
  referenceDir: string,
  targets: TargetSpec[],
  options: CompareOptions = {}
): ParityMatrix {
  if (targets.length === 0) throw new Error('a parity matrix needs at least one target');

  const refDir = path.resolve(referenceDir);
  const referenceManifest = loadManifest(refDir);

  const results: TargetResult[] = targets.map((t) => {
    const report = compareRuns(refDir, t.dir, options);
    return {
      label: t.label,
      dir: path.resolve(t.dir),
      manifest: report.candidate.manifest,
      platform: report.candidate.manifest.device.platform,
      passed: report.passed,
      report,
    };
  });

  // Rows follow the reference's checkpoint order — that is the journey the
  // targets are being held to. Checkpoints only a target recorded are appended,
  // so nothing a run captured is silently dropped from the grid.
  const rowNames: string[] = referenceManifest.checkpoints.map((c) => c.name);
  const seen = new Set(rowNames);
  for (const t of results) {
    for (const cp of t.report.checkpoints) {
      if (!seen.has(cp.name)) {
        seen.add(cp.name);
        rowNames.push(cp.name);
      }
    }
  }

  const rows: MatrixRow[] = rowNames.map((name) => {
    const cells: MatrixCell[] = results.map((t) => {
      const cp = t.report.checkpoints.find((c) => c.name === name);
      if (!cp) return { target: t.label, status: 'absent' as const, blocking: 0, advisory: 0 };
      const blocking = cp.findings.filter((f) => f.severity === 'blocking').length;
      const advisory = cp.findings.filter((f) => f.severity === 'advisory').length;
      return {
        target: t.label,
        status: cp.passed ? ('pass' as const) : ('fail' as const),
        blocking,
        advisory,
      };
    });
    return { checkpoint: name, cells, passed: cells.every((c) => c.status !== 'fail') };
  });

  // ── Cross-target rollup ──
  const groups = new Map<string, SharedFinding>();
  for (const t of results) {
    for (const cp of t.report.checkpoints) {
      for (const f of cp.findings) {
        const signature = findingSignature(cp.name, f);
        const existing = groups.get(signature);
        if (existing) {
          if (!existing.targets.includes(t.label)) existing.targets.push(t.label);
          // A finding that blocks anywhere is worth reading as blocking.
          if (f.severity === 'blocking') existing.severity = 'blocking';
          continue;
        }
        groups.set(signature, {
          signature,
          checkpoint: cp.name,
          kind: f.kind,
          severity: f.severity,
          subject: subjectOf(f),
          role: f.role,
          identifier: f.identifier,
          targets: [t.label],
          universal: false,
          detail: f.detail,
        });
      }
    }
  }

  const shared = [...groups.values()];
  for (const s of shared) {
    // "Universal" only means something once there are several targets to agree.
    s.universal = results.length > 1 && s.targets.length === results.length;
  }
  // Universal first (they point at the reference), then blocking, then by
  // breadth — the finding affecting the most targets is the one to fix first.
  shared.sort((a, b) => {
    if (a.universal !== b.universal) return a.universal ? -1 : 1;
    if (a.severity !== b.severity) return a.severity === 'blocking' ? -1 : 1;
    if (a.targets.length !== b.targets.length) return b.targets.length - a.targets.length;
    return a.checkpoint.localeCompare(b.checkpoint);
  });

  const blocking = results.reduce((n, t) => n + t.report.summary.blocking, 0);
  const advisory = results.reduce((n, t) => n + t.report.summary.advisory, 0);

  return {
    version: 1,
    passed: results.every((t) => t.passed),
    comparedAt: new Date().toISOString(),
    reference: {
      dir: refDir,
      label: referenceManifest.label ?? 'reference',
      manifest: referenceManifest,
    },
    targets: results,
    rows,
    shared,
    summary: {
      targets: results.length,
      targetsPassed: results.filter((t) => t.passed).length,
      checkpoints: rows.length,
      blocking,
      advisory,
      universal: shared.filter((s) => s.universal).length,
    },
  };
}

// ── Terminal rendering ───────────────────────────────────────────────────────

const MARK: Record<MatrixCell['status'], string> = { pass: '✓', fail: '✗', absent: '·' };

/** The checkpoint × target grid, plus what the targets agree on. */
export function renderMatrixText(matrix: ParityMatrix): string {
  const lines: string[] = [];
  const labels = matrix.targets.map((t) => t.label);

  // Column width: wide enough for the label and for a "✗ 3!" cell.
  const nameWidth = Math.max(10, ...matrix.rows.map((r) => r.checkpoint.length));
  const colWidth = labels.map((l) => Math.max(l.length, 6));

  lines.push(
    '  ' +
      'checkpoint'.padEnd(nameWidth) +
      '  ' +
      labels.map((l, i) => l.padEnd(colWidth[i])).join('  ')
  );
  lines.push('  ' + '─'.repeat(nameWidth) + '  ' + colWidth.map((w) => '─'.repeat(w)).join('  '));

  for (const row of matrix.rows) {
    const cells = row.cells.map((c, i) => {
      const suffix = c.blocking > 0 ? ` ${c.blocking}!` : c.advisory > 0 ? ` ${c.advisory}·` : '';
      return `${MARK[c.status]}${suffix}`.padEnd(colWidth[i]);
    });
    lines.push('  ' + row.checkpoint.padEnd(nameWidth) + '  ' + cells.join('  '));
  }

  if (matrix.shared.length) {
    const universal = matrix.shared.filter((s) => s.universal);
    if (universal.length) {
      lines.push('');
      lines.push(`Every target reports these ${universal.length} finding(s) —`);
      lines.push('look at the reference before the targets:');
      for (const s of universal) {
        lines.push(`  ! [${s.kind}] ${s.checkpoint}: ${s.detail}`);
      }
    }

    const perTarget = matrix.shared.filter((s) => !s.universal && s.severity === 'blocking');
    if (perTarget.length) {
      lines.push('');
      lines.push('Blocking findings by target:');
      for (const s of perTarget) {
        lines.push(`  ! [${s.kind}] ${s.checkpoint}: ${s.detail}`);
        lines.push(`      on: ${s.targets.join(', ')}`);
      }
    }
  }

  lines.push('');
  const t = matrix.summary;
  lines.push(
    `${t.targetsPassed}/${t.targets} targets at parity over ${t.checkpoints} checkpoint(s) — ` +
      `${t.blocking} blocking, ${t.advisory} advisory` +
      (t.universal ? `, ${t.universal} reported by every target` : '')
  );
  return lines.join('\n');
}
