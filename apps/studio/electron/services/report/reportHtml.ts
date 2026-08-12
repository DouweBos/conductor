import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Highlight, TestRunLog, TestStepStatus } from "../../../app/lib/types";

/**
 * Renders a run-log into a self-contained HTML report for a non-engineer:
 * verdict, plan, expectations with evidence, and the step timeline. Screenshots
 * are inlined as data URIs so the file can be mailed around on its own.
 */

const VERDICT = {
  PASS: { label: "PASS", bg: "#e7f5e9", fg: "#1e7d32" },
  FAIL: { label: "FAIL", bg: "#fdecea", fg: "#b3261e" },
  BLOCKED: { label: "BLOCKED", bg: "#fff4e5", fg: "#8a5300" },
};

const STATUS: Record<TestStepStatus, { dot: string; tag: string; mark: string }> = {
  pass: { dot: "#2e7d32", tag: "PASS", mark: "✓" },
  fail: { dot: "#c62828", tag: "FAIL", mark: "✗" },
  info: { dot: "#8a8f98", tag: "INFO", mark: "•" },
};

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function esc(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function dataUri(file: string | undefined, baseDir: string): string | null {
  if (!file) return null;
  const abs = path.isAbsolute(file) ? file : path.resolve(baseDir, file);
  if (!existsSync(abs)) return null;
  try {
    const mime = MIME[path.extname(abs).toLowerCase()] ?? "image/png";
    return `data:${mime};base64,${readFileSync(abs).toString("base64")}`;
  } catch {
    return null;
  }
}

function planBlock(title: string, items: string[] | undefined): string {
  if (!items?.length) return "";
  return `<div class="plancol"><h3>${esc(title)}</h3><ul>${items
    .map((x) => `<li>${esc(x)}</li>`)
    .join("")}</ul></div>`;
}

/** The screenshot, with the checked element outlined over it. */
function shotWithHighlight(img: string, box: Highlight | undefined, alt: string): string {
  if (!box) return `<img class="shot" src="${img}" alt="${esc(alt)}"/>`;
  const pct = (n: number) => `${(n * 100).toFixed(3)}%`;
  return `<div class="shotwrap">
      <img class="shot" src="${img}" alt="${esc(alt)}"/>
      <span class="box" style="left:${pct(box.x)};top:${pct(box.y)};width:${pct(box.width)};height:${pct(box.height)}"></span>
    </div>`;
}

export function renderReportHtml(log: TestRunLog, baseDir: string, caseId?: string): string {
  const verdict = VERDICT[log.verdict] ?? VERDICT.BLOCKED;

  const expectations = (log.expectations ?? [])
    .map((e, i) => {
      const s = STATUS[e.status] ?? STATUS.info;
      const img = dataUri(e.screenshot, baseDir);
      return `<div class="check" id="check-${i + 1}">
      <div class="checkhead">
        <span class="ico" style="color:${s.dot}">${s.mark}</span>
        <span class="checktext">${esc(e.text)}</span>
        <span class="tag" style="color:${s.dot};border-color:${s.dot}">${s.tag}</span>
      </div>
      ${e.evidence ? `<div class="evidence"><code>${esc(e.evidence)}</code></div>` : ""}
      ${img ? shotWithHighlight(img, e.highlight, `evidence for “${e.text}”`) : ""}
    </div>`;
    })
    .join("");

  // Every captured moment at a glance, each jumping to the check it proves.
  const filmstrip = (log.expectations ?? [])
    .map((e, i) => {
      const img = dataUri(e.screenshot, baseDir);
      if (!img) return "";
      const s = STATUS[e.status] ?? STATUS.info;
      return `<a class="frame" href="#check-${i + 1}" title="${esc(e.text)}">
      <img src="${img}" alt="${esc(e.text)}"/>
      <span class="framebar" style="background:${s.dot}"></span>
    </a>`;
    })
    .join("");

  const steps = (log.steps ?? [])
    .map((st, i) => {
      const s = STATUS[st.status ?? "info"] ?? STATUS.info;
      const img = dataUri(st.screenshot, baseDir);
      return `<div class="step">
      <div class="stephead">
        <span class="dot" style="background:${s.dot}"></span>
        <span class="stepn">${esc(st.n ?? i + 1)}</span>
        <span class="steptitle">${esc(st.title || st.kind || "")}</span>
        <span class="tag" style="color:${s.dot};border-color:${s.dot}">${s.tag}</span>
      </div>
      ${st.detail ? `<div class="detail">${esc(st.detail)}</div>` : ""}
      ${st.evidence ? `<div class="evidence"><code>${esc(st.evidence)}</code></div>` : ""}
      ${img ? shotWithHighlight(img, st.highlight, `screenshot for step ${st.n ?? i + 1}`) : ""}
    </div>`;
    })
    .join("");

  const hasPlan = Boolean(
    log.plan?.preconditions?.length || log.plan?.actions?.length || log.plan?.expectations?.length,
  );

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<title>${esc(log.title || "Agentic Test Report")}</title>
<style>
  :root { --ink:#1a1d21; --muted:#6b7280; --line:#e5e7eb; --brand:#6c7bff; }
  * { box-sizing: border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; color:var(--ink); margin:0; background:#fff; }
  .page { max-width:900px; margin:0 auto; padding:44px 48px; }
  header { border-bottom:4px solid var(--brand); padding-bottom:16px; margin-bottom:8px; }
  .brand { font-size:12px; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); }
  h1 { font-size:26px; margin:6px 0 4px; }
  .desc { color:var(--muted); font-size:14px; margin:0; }
  .verdict { display:inline-block; margin:18px 0; padding:10px 20px; border-radius:8px;
    background:${verdict.bg}; color:${verdict.fg}; font-weight:700; font-size:18px; letter-spacing:.04em; }
  .meta { display:flex; flex-wrap:wrap; gap:8px 28px; font-size:13px; color:var(--muted); margin-bottom:6px; }
  .meta b { color:var(--ink); font-weight:600; }
  .adjusted { background:#fff4e5; border-left:3px solid #ed6c02; padding:10px 16px; border-radius:4px;
    font-size:13px; line-height:1.5; margin:14px 0; }
  .adjusted ul { margin:6px 0 0; padding-left:18px; }
  .summary { background:#f8f9fa; border-left:3px solid var(--brand); padding:12px 16px; border-radius:4px;
    font-size:14px; line-height:1.5; margin:14px 0 26px; }
  h2 { font-size:15px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted);
    border-bottom:1px solid var(--line); padding-bottom:6px; margin:30px 0 14px; }
  .plan { display:flex; gap:28px; flex-wrap:wrap; }
  .plancol { flex:1; min-width:200px; } .plancol h3 { font-size:13px; margin:0 0 6px; }
  .plancol ul { margin:0; padding-left:18px; font-size:13px; line-height:1.5; }
  .strip { display:flex; gap:10px; overflow:hidden; flex-wrap:wrap; }
  .frame { position:relative; display:block; width:104px; border:1px solid var(--line); border-radius:6px;
    overflow:hidden; text-decoration:none; }
  .frame img { display:block; width:100%; }
  .framebar { display:block; height:4px; width:100%; }
  .check { border:1px solid var(--line); border-radius:8px; padding:14px 16px; margin-bottom:14px; break-inside:avoid; }
  .checkhead { display:flex; align-items:baseline; gap:10px; }
  .checktext { font-weight:600; font-size:15px; flex:1; }
  .ico { font-weight:800; }
  .shotwrap { position:relative; display:block; margin-top:12px; line-height:0; }
  .shotwrap .shot { margin-top:0; }
  .box { position:absolute; border:3px solid #6c7bff; border-radius:4px;
    box-shadow:0 0 0 9999px rgba(17,20,32,0.35); }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  td { padding:9px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  td.ico { width:22px; font-weight:800; text-align:center; }
  td.ev { color:var(--muted); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  .step { border:1px solid var(--line); border-radius:8px; padding:14px 16px; margin-bottom:14px; break-inside:avoid; }
  .stephead { display:flex; align-items:center; gap:10px; }
  .dot { width:10px; height:10px; border-radius:50%; flex:0 0 auto; }
  .stepn { color:var(--muted); font-size:12px; font-weight:700; min-width:18px; }
  .steptitle { font-weight:600; font-size:15px; flex:1; }
  .tag { font-size:10px; font-weight:700; letter-spacing:.06em; border:1px solid; border-radius:4px; padding:1px 6px; }
  .detail { font-size:13px; color:#374151; margin:8px 0 0; line-height:1.5; }
  .evidence { margin-top:8px; }
  .evidence code { display:block; background:#f4f4f5; border-radius:4px; padding:6px 9px;
    font-size:12px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; word-break:break-word; }
  .shot { display:block; max-width:100%; margin-top:12px; border:1px solid var(--line); border-radius:6px; }
  footer { margin-top:36px; padding-top:12px; border-top:1px solid var(--line); font-size:11px; color:var(--muted); }
  @page { margin:14mm; }
</style></head><body><div class="page">
  <header>
    <div class="brand">Conductor Studio · Agentic Test Report</div>
    <h1>${esc(log.title || "Untitled test")}</h1>
    ${log.description ? `<p class="desc">${esc(log.description)}</p>` : ""}
  </header>

  <div class="verdict">${verdict.label}</div>

  <div class="meta">
    ${caseId ? `<span><b>Test case:</b> ${esc(caseId)}</span>` : ""}
    ${log.platform ? `<span><b>Platform:</b> ${esc(log.platform)}</span>` : ""}
    ${log.device ? `<span><b>Device:</b> ${esc(log.device)}</span>` : ""}
    ${log.startedAt ? `<span><b>Started:</b> ${esc(log.startedAt)}</span>` : ""}
    ${log.finishedAt ? `<span><b>Finished:</b> ${esc(log.finishedAt)}</span>` : ""}
  </div>

  ${log.adjustments?.length
    ? `<div class="adjusted"><b>Studio corrected this verdict.</b><ul>${log.adjustments
        .map((a) => `<li>${esc(a)}</li>`)
        .join("")}</ul></div>`
    : ""}

  ${log.summary ? `<div class="summary">${esc(log.summary)}</div>` : ""}

  ${hasPlan
    ? `<h2>Test plan</h2><div class="plan">
        ${planBlock("Preconditions", log.plan?.preconditions)}
        ${planBlock("Actions", log.plan?.actions)}
        ${planBlock("Expectations", log.plan?.expectations)}
      </div>`
    : ""}

  ${filmstrip ? `<h2>The run at a glance</h2><div class="strip">${filmstrip}</div>` : ""}

  ${expectations ? `<h2>Expectations checked</h2>${expectations}` : ""}

  ${steps ? `<h2>Steps taken</h2>${steps}` : ""}

  <footer>Generated by Conductor Studio's agent · run-log.json sits next to this file.</footer>
</div></body></html>`;
}
