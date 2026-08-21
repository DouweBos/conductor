import { caseAutomationBrief, runArtifacts } from "./ipc";
import { setView } from "./router";
import type { Case, RunRecord, TestReport } from "./types";
import { setPendingPrompt } from "../stores/agentStore";

/**
 * Send a failed run to the agent with what actually happened: the step that
 * failed, the tail of the output, and the paths to maestro's screenshot and
 * screen hierarchy for that step. Starting the agent cold means it re-derives
 * all of that by hand.
 */
export async function askAgentToFix(record: RunRecord): Promise<void> {
  const lines = [
    `The flow \`${record.flowPath}\` failed. Fix it.`,
    "",
    `Engine: ${record.engine}. Device: ${record.deviceId ?? "none"}.`,
  ];

  const artifacts = record.artifactDir ? await runArtifacts(record.runId).catch(() => null) : null;
  const failed = artifacts?.steps.find((step) => step.status === "FAILED");
  if (failed) {
    lines.push("", `It failed on step ${failed.index + 1}: ${failed.label}.`);
    if (failed.screenshot) lines.push(`Screenshot of that moment: ${failed.screenshot}`);
    if (failed.hierarchy) lines.push(`Screen hierarchy at that moment: ${failed.hierarchy}`);
    const before = artifacts?.steps.filter((s) => s.status === "COMPLETED").slice(-3) ?? [];
    if (before.length) {
      lines.push("", `Steps that passed just before: ${before.map((s) => s.label).join(" → ")}.`);
    }
  }

  const tail = record.output.slice(-25);
  if (tail.length) lines.push("", "Output:", "```", ...tail, "```");
  lines.push(
    "",
    "Read the flow, inspect the current screen with conductor, and correct the",
    "selector or the step that broke. Don't rewrite the flow wholesale.",
  );

  setPendingPrompt(lines.join("\n"));
  setView("agent");
}

/**
 * Hand a case to the agent to verify on the device. A case with no flow is
 * otherwise stuck waiting for someone to automate it; the agent can execute the
 * steps as written and file the result itself.
 */
export function askAgentToVerifyCase(c: Case, column?: string): void {
  const lines = [
    `Verify test case ${c.ref} — "${c.title}" — on the device, then report on it.`,
    "",
    `Read it first with \`describe_test_case\` (id: ${c.ref}). Its steps are the script; don't invent your own.`,
  ];
  if (column) lines.push(`Test the ${column} column.`);
  if (c.description) lines.push("", `Business rule: ${c.description}`);
  if (c.preconditions) lines.push("", "Preconditions:", c.preconditions);
  if (c.steps?.length) {
    lines.push(
      "",
      "Steps:",
      ...c.steps.map(
        (s, i) => `${i + 1}. ${s.action}${s.expected_result ? ` → expect: ${s.expected_result}` : ""}`,
      ),
    );
  }
  lines.push(
    "",
    `Start with \`start_test_report\`, assert every expectation with a structured check, and finish with \`write_test_report\` passing caseId "${c.ref}".`,
  );

  setPendingPrompt(lines.join("\n"));
  setView("agent");
}

/**
 * Hand a case to the agent to *automate*. The brief is assembled in the main
 * process — the case, the same case's flow on another platform, the page
 * objects, the known screens — because starting the agent cold means it spends
 * its first twenty minutes rediscovering all of it.
 */
export async function askAgentToAutomateCase(c: Case, column?: string): Promise<void> {
  const brief = await caseAutomationBrief(c.ref, column).catch(
    () => `Write the Maestro flow for test case ${c.ref} — "${c.title}". Read it with \`describe_test_case\` first.`,
  );
  setPendingPrompt(brief);
  setView("agent");
}

/**
 * Turn a report into something repeatable. A behaviour worth verifying once is
 * usually worth a flow, and the run-log already holds the exact steps.
 */
export function askAgentToWriteFlow(report: TestReport): void {
  setPendingPrompt(
    [
      `Turn the agentic test "${report.title}" into a reusable Maestro flow.`,
      "",
      `Its run-log is at ${report.dir}/run-log.json — the steps it performed and the checks it made are in there.`,
      "Read it, then write a flow that performs the same steps and asserts the same expectations.",
      report.caseId ? `Link the flow to case ${report.caseId} once it passes.` : "",
      "Compose existing POMs where they cover a step rather than re-deriving selectors.",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  setView("agent");
}

/** Run the same test again — the description and plan are in the run-log. */
export function askAgentToRerun(report: TestReport): void {
  setPendingPrompt(
    [
      `Run the agentic test "${report.title}" again and file a fresh report.`,
      "",
      `The previous run-log is at ${report.dir}/run-log.json: it holds the original request, the plan, and what the last run observed (verdict: ${report.verdict}).`,
      "Read it, execute the same plan, and report what you find now — don't assume the previous verdict still holds.",
      report.caseId ? `Pass caseId "${report.caseId}" to write_test_report.` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  setView("agent");
}
