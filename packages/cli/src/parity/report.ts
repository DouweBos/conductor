/**
 * Self-contained HTML parity report.
 *
 * The JSON report is what an agent reads; this is what a human looks at before
 * signing off on a checkpoint. Images are inlined as data URIs so the file can
 * be attached to a PR or opened from anywhere without its run directories.
 */
import fs from 'fs';
import path from 'path';
import type { ParityReport } from './compare.js';
import type { CheckpointDiff, Finding } from './diff.js';
import type { MatrixCell, ParityMatrix } from './matrix.js';
import { slugify } from './store.js';

function dataUri(file: string): string | null {
  try {
    return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
  } catch {
    return null;
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function findingRow(f: Finding): string {
  return (
    `<li class="f ${esc(f.severity)}">` +
    `<span class="kind">${esc(f.kind)}</span>` +
    `<span class="detail">${esc(f.detail)}</span>` +
    `</li>`
  );
}

function checkpointSection(cp: CheckpointDiff, refDir: string, candDir: string): string {
  const slug = slugify(cp.name);
  const ref = dataUri(path.join(refDir, `${slug}.png`));
  const cand = dataUri(path.join(candDir, `${slug}.png`));
  const diff = cp.pixel?.diffPath ? dataUri(cp.pixel.diffPath) : null;

  const shot = (title: string, uri: string | null): string =>
    `<figure>${
      uri ? `<img src="${uri}" alt="${esc(title)}">` : `<div class="nopng">not captured</div>`
    }<figcaption>${esc(title)}</figcaption></figure>`;

  const pixelNote = cp.pixel
    ? cp.pixel.skipped
      ? `<p class="note">pixel diff skipped — ${esc(cp.pixel.skipped)}</p>`
      : `<p class="note">${(cp.pixel.ratio * 100).toFixed(2)}% of pixels differ</p>`
    : '';

  const findings = cp.findings.length
    ? `<ul class="findings">${cp.findings.map(findingRow).join('')}</ul>`
    : `<p class="note">No findings.</p>`;

  return `
<section class="cp ${cp.passed ? 'pass' : 'fail'}">
  <h2><span class="badge">${cp.passed ? 'PASS' : 'FAIL'}</span> ${esc(cp.name)}${
    cp.scaled ? '<span class="tag">frames rescaled</span>' : ''
  }${cp.rolesRelaxed ? '<span class="tag">roles relaxed</span>' : ''}</h2>
  <div class="shots">
    ${shot('Reference', ref)}
    ${shot('Candidate', cand)}
    ${diff ? shot('Pixel diff', diff) : ''}
  </div>
  ${pixelNote}
  ${findings}
</section>`;
}

export function renderHtml(report: ParityReport): string {
  const { summary } = report;
  const refDir = report.reference.dir;
  const candDir = report.candidate.dir;

  const meta = (label: string, value: string): string =>
    `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parity report — ${esc(report.candidate.manifest.label ?? report.candidate.manifest.flow ?? 'run')}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fff; --fg: #16181d; --muted: #626871; --line: #e3e6ea;
    --pass: #167a45; --fail: #c02a37; --card: #f7f8fa;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #14161a; --fg: #e8eaed; --muted: #9aa1ab; --line: #2a2e35;
            --pass: #4cc38a; --fail: #f2707c; --card: #1b1e24; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--fg);
         font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 20px; }
  dl.meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 10px; margin: 0 0 24px; padding: 14px; background: var(--card);
            border: 1px solid var(--line); border-radius: 10px; }
  dl.meta dt { color: var(--muted); font-size: 11px; text-transform: uppercase;
               letter-spacing: .04em; margin: 0 0 2px; }
  dl.meta dd { margin: 0; word-break: break-word; }
  .verdict { font-weight: 600; }
  .verdict.pass { color: var(--pass); } .verdict.fail { color: var(--fail); }
  section.cp { border: 1px solid var(--line); border-radius: 10px; padding: 16px;
               margin: 0 0 18px; background: var(--card); }
  section.cp h2 { font-size: 16px; margin: 0 0 12px; display: flex; align-items: center;
                  gap: 8px; flex-wrap: wrap; }
  .badge { font-size: 11px; font-weight: 700; letter-spacing: .06em; padding: 2px 7px;
           border-radius: 5px; color: #fff; background: var(--fail); }
  .cp.pass .badge { background: var(--pass); }
  .tag { font-size: 11px; color: var(--muted); border: 1px solid var(--line);
         padding: 1px 6px; border-radius: 5px; font-weight: 400; }
  .shots { display: flex; gap: 12px; flex-wrap: wrap; }
  .shots figure { margin: 0; flex: 1 1 220px; min-width: 0; }
  .shots img { width: 100%; height: auto; border: 1px solid var(--line); border-radius: 6px;
               background: var(--bg); }
  .nopng { border: 1px dashed var(--line); border-radius: 6px; padding: 32px 8px;
           text-align: center; color: var(--muted); }
  figcaption { color: var(--muted); font-size: 12px; margin-top: 5px; text-align: center; }
  .note { color: var(--muted); margin: 12px 0 0; }
  ul.findings { list-style: none; margin: 14px 0 0; padding: 0; }
  li.f { display: flex; gap: 10px; padding: 7px 0; border-top: 1px solid var(--line);
         align-items: baseline; }
  li.f .kind { flex: 0 0 auto; font-size: 11px; font-weight: 700; letter-spacing: .04em;
               text-transform: uppercase; min-width: 132px; color: var(--muted); }
  li.f.blocking .kind { color: var(--fail); }
  li.f .detail { flex: 1 1 auto; min-width: 0; }
  @media (max-width: 560px) {
    li.f { flex-direction: column; gap: 2px; }
    li.f .kind { min-width: 0; }
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>Parity report</h1>
  <p class="sub">${esc(report.comparedAt)}</p>
  <dl class="meta">
    ${meta('Verdict', report.passed ? 'PASS' : 'FAIL')}
    ${meta('Checkpoints', `${summary.passed}/${summary.checkpoints} passed`)}
    ${meta('Blocking findings', String(summary.blocking))}
    ${meta('Advisory findings', String(summary.advisory))}
    ${meta(
      'Reference',
      `${report.reference.manifest.device.platform} ${report.reference.manifest.device.width}×${report.reference.manifest.device.height}`
    )}
    ${meta(
      'Candidate',
      `${report.candidate.manifest.device.platform} ${report.candidate.manifest.device.width}×${report.candidate.manifest.device.height}`
    )}
  </dl>
  ${report.checkpoints.map((cp) => checkpointSection(cp, refDir, candDir)).join('\n')}
</div>
</body>
</html>
`;
}

export function writeHtml(report: ParityReport, outPath: string): string {
  const resolved = path.resolve(outPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, renderHtml(report), 'utf-8');
  return resolved;
}

// ── Terminal rendering ───────────────────────────────────────────────────────

/** Compact, agent-readable text summary. */
export function renderText(report: ParityReport): string {
  const lines: string[] = [];
  const { summary } = report;

  for (const cp of report.checkpoints) {
    lines.push(`${cp.passed ? '✓' : '✗'} ${cp.name}`);
    if (cp.pixel && !cp.pixel.skipped) {
      lines.push(`    pixels: ${(cp.pixel.ratio * 100).toFixed(2)}% differ`);
    }
    for (const f of cp.findings) {
      const mark = f.severity === 'blocking' ? '!' : '·';
      lines.push(`    ${mark} [${f.kind}] ${f.detail}`);
    }
  }

  lines.push('');
  lines.push(
    `${summary.passed}/${summary.checkpoints} checkpoints passed — ` +
      `${summary.blocking} blocking, ${summary.advisory} advisory`
  );
  return lines.join('\n');
}

// ── Matrix report (one reference, many targets) ──────────────────────────────

const CELL_MARK: Record<MatrixCell['status'], string> = { pass: '✓', fail: '✗', absent: '–' };

function matrixGrid(matrix: ParityMatrix): string {
  const head = matrix.targets
    .map(
      (t) =>
        `<th><span class="tl">${esc(t.label)}</span><span class="tp">${esc(t.platform)}</span></th>`
    )
    .join('');

  const body = matrix.rows
    .map((row) => {
      const cells = row.cells
        .map((c) => {
          const count =
            c.blocking > 0
              ? `<span class="n blocking">${c.blocking}</span>`
              : c.advisory > 0
                ? `<span class="n">${c.advisory}</span>`
                : '';
          return `<td class="cell ${esc(c.status)}"><span class="mark">${CELL_MARK[c.status]}</span>${count}</td>`;
        })
        .join('');
      return `<tr><th scope="row">${esc(row.checkpoint)}</th>${cells}</tr>`;
    })
    .join('');

  return `<div class="gridwrap"><table class="grid">
    <thead><tr><th scope="col">Checkpoint</th>${head}</tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

function sharedList(matrix: ParityMatrix): string {
  if (!matrix.shared.length) return '';
  const universal = matrix.shared.filter((s) => s.universal);
  const rest = matrix.shared.filter((s) => !s.universal);

  const row = (s: (typeof matrix.shared)[number]): string =>
    `<li class="f ${esc(s.severity)}">` +
    `<span class="kind">${esc(s.kind)}</span>` +
    `<span class="detail"><strong>${esc(s.checkpoint)}</strong> — ${esc(s.detail)}` +
    `<span class="on">${s.targets.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</span>` +
    `</span></li>`;

  const parts: string[] = [];
  if (universal.length) {
    parts.push(`<section class="cp fail">
      <h2>Reported by every target</h2>
      <p class="note">These ${universal.length} finding(s) appear on all ${matrix.targets.length}
      targets. Independent rebuilds rarely diverge the same way — look at the reference run
      first: it may be stale, behind a flag, or in a different experiment bucket.</p>
      <ul class="findings">${universal.map(row).join('')}</ul>
    </section>`);
  }
  if (rest.length) {
    parts.push(`<section class="cp">
      <h2>Per-target findings</h2>
      <ul class="findings">${rest.map(row).join('')}</ul>
    </section>`);
  }
  return parts.join('\n');
}

export function renderMatrixHtml(matrix: ParityMatrix): string {
  const s = matrix.summary;
  const meta = (label: string, value: string): string =>
    `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parity matrix — ${esc(matrix.reference.label)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fff; --fg: #16181d; --muted: #626871; --line: #e3e6ea;
    --pass: #167a45; --fail: #c02a37; --card: #f7f8fa; --chip: #eceef1;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #14161a; --fg: #e8eaed; --muted: #9aa1ab; --line: #2a2e35;
            --pass: #4cc38a; --fail: #f2707c; --card: #1b1e24; --chip: #262a31; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--fg);
         font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 20px; }
  dl.meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 10px; margin: 0 0 24px; padding: 14px; background: var(--card);
            border: 1px solid var(--line); border-radius: 10px; }
  dl.meta dt { color: var(--muted); font-size: 11px; text-transform: uppercase;
               letter-spacing: .04em; margin: 0 0 2px; }
  dl.meta dd { margin: 0; word-break: break-word; }
  section.cp { border: 1px solid var(--line); border-radius: 10px; padding: 16px;
               margin: 0 0 18px; background: var(--card); }
  section.cp h2 { font-size: 16px; margin: 0 0 10px; }
  section.cp.fail { border-color: var(--fail); }
  .note { color: var(--muted); margin: 0 0 12px; }
  .gridwrap { overflow-x: auto; margin: 0 0 18px; }
  table.grid { border-collapse: collapse; width: 100%; min-width: 480px; }
  table.grid th, table.grid td { border: 1px solid var(--line); padding: 7px 10px;
                                 text-align: left; }
  table.grid thead th { background: var(--card); font-size: 12px; vertical-align: bottom; }
  .tl { display: block; font-weight: 600; }
  .tp { display: block; color: var(--muted); font-weight: 400; font-size: 11px; }
  table.grid tbody th { font-weight: 400; background: var(--card); white-space: nowrap; }
  td.cell { text-align: center; width: 92px; white-space: nowrap; }
  td.cell .mark { font-weight: 700; }
  td.cell.pass .mark { color: var(--pass); }
  td.cell.fail .mark { color: var(--fail); }
  td.cell.absent .mark { color: var(--muted); }
  .n { display: inline-block; margin-left: 6px; font-size: 11px; color: var(--muted); }
  .n.blocking { color: var(--fail); font-weight: 700; }
  ul.findings { list-style: none; margin: 0; padding: 0; }
  li.f { display: flex; gap: 10px; padding: 8px 0; border-top: 1px solid var(--line);
         align-items: baseline; }
  li.f:first-child { border-top: 0; }
  li.f .kind { flex: 0 0 auto; font-size: 11px; font-weight: 700; letter-spacing: .04em;
               text-transform: uppercase; min-width: 132px; color: var(--muted); }
  li.f.blocking .kind { color: var(--fail); }
  li.f .detail { flex: 1 1 auto; min-width: 0; }
  .on { display: block; margin-top: 5px; }
  .chip { display: inline-block; background: var(--chip); border-radius: 5px;
          padding: 1px 7px; margin: 2px 4px 0 0; font-size: 11px; }
  @media (max-width: 560px) {
    li.f { flex-direction: column; gap: 2px; }
    li.f .kind { min-width: 0; }
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>Parity matrix</h1>
  <p class="sub">${esc(matrix.reference.label)} vs ${matrix.targets.length} target(s) · ${esc(matrix.comparedAt)}</p>
  <dl class="meta">
    ${meta('Verdict', matrix.passed ? 'PASS' : 'FAIL')}
    ${meta('Targets at parity', `${s.targetsPassed}/${s.targets}`)}
    ${meta('Checkpoints', String(s.checkpoints))}
    ${meta('Blocking', String(s.blocking))}
    ${meta('Advisory', String(s.advisory))}
    ${meta('On every target', String(s.universal))}
  </dl>
  ${matrixGrid(matrix)}
  ${sharedList(matrix)}
</div>
</body>
</html>
`;
}

export function writeMatrixHtml(matrix: ParityMatrix, outPath: string): string {
  const resolved = path.resolve(outPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, renderMatrixHtml(matrix), 'utf-8');
  return resolved;
}
