import type { TestRunLog } from "../../../app/lib/types";

/**
 * The report as markdown, for the places a PDF can't go — a PR description, a
 * GitHub issue, a Slack message. Screenshots are referenced by file name rather
 * than embedded: whoever reads this can't see a base64 blob anyway, and the
 * report folder travels alongside.
 */
const MARK = { pass: "✅", fail: "❌", info: "•" };

export function renderReportMarkdown(log: TestRunLog, caseId?: string): string {
  // One entry per block; blocks are separated by a blank line, lines inside one
  // are not — a table with blank lines between its rows isn't a table.
  const blocks: string[] = [`## ${log.title} — **${log.verdict}**`];

  const meta = [
    caseId ? `case ${caseId}` : "",
    log.platform,
    log.device,
    log.startedAt ? `run ${log.startedAt}` : "",
  ].filter(Boolean);
  if (meta.length) blocks.push(`_${meta.join(" · ")}_`);
  if (log.description) blocks.push(`> ${log.description}`);
  for (const adjustment of log.adjustments ?? []) {
    blocks.push(`> ⚠️ **Verdict corrected by Studio.** ${adjustment}`);
  }
  if (log.summary) blocks.push(log.summary);

  if (log.expectations?.length) {
    blocks.push("### Expectations");
    blocks.push(
      [
        "| | Expectation | Evidence |",
        "| --- | --- | --- |",
        ...log.expectations.map(
          (e) => `| ${MARK[e.status] ?? MARK.info} | ${cell(e.text)} | ${code(e.evidence)} |`,
        ),
      ].join("\n"),
    );
  }

  const steps = log.steps ?? [];
  if (steps.length) {
    blocks.push(
      [
        "<details><summary>Steps taken</summary>",
        "",
        ...steps.flatMap((s, i) => {
          const line = `${s.n ?? i + 1}. ${MARK[s.status ?? "info"] ?? MARK.info} ${s.title}${
            s.detail ? ` — ${s.detail}` : ""
          }`;
          return s.evidence ? [line, `   ${code(s.evidence)}`] : [line];
        }),
        "",
        "</details>",
      ].join("\n"),
    );
  }

  const shots = [...(log.expectations ?? []), ...steps]
    .map((x) => x.screenshot?.split("/").pop())
    .filter((s): s is string => Boolean(s));
  if (shots.length) {
    blocks.push(`_Screenshots: ${[...new Set(shots)].join(", ")} (in the report folder)._`);
  }

  return blocks.join("\n\n");
}

/** Pipes and newlines would break the row this sits in. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

function code(text: string | undefined): string {
  return text ? `\`${cell(text).replace(/`/g, "'")}\`` : "";
}
