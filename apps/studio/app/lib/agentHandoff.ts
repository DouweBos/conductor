import { runArtifacts } from "./ipc";
import { setView } from "./router";
import type { RunRecord } from "./types";
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
