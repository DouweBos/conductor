import type { DeviceInfo, SceneGraph } from "../../../app/lib/types";
import { getProjectInfo } from "../file/fileService";
import { listCases } from "../cases/casesService";
import { selectedProjects } from "../cases/projects";
import { listPoms } from "../pom/pomService";
import { appFingerprint } from "../conductor/conductorService";
import { loadSceneGraph } from "../scenegraph/sceneGraphService";
import { resolveConductor } from "../maestro/maestroService";

/**
 * Build the agent's system prompt: it drives the app through the conductor CLI,
 * reuses the repo's Maestro subflow POMs, and is seeded with the scene graph so
 * it skips re-orientation. Mirrors how Argus injects a runtime section
 * describing the attached device + conductor.
 */
export async function buildAgentSystemPrompt(device: DeviceInfo | null): Promise<string> {
  const project = getProjectInfo();
  // Identify the foreground app up front so the agent starts with that app's
  // graph rather than an empty one.
  const app = device ? await appFingerprint(device.id, device.platform).catch(() => null) : null;
  const [poms, graph, conductor] = await Promise.all([
    listPoms().catch(() => []),
    loadSceneGraph(app).catch((): SceneGraph => ({ version: 1, nodes: [], edges: [] })),
    resolveConductor().catch(() => null),
  ]);

  // The shim, not `bin`+`prefixArgs`: the agent runs this from a Bash tool,
  // where Studio's `electron --run-as-node <entry>` form wouldn't survive.
  const conductorInvocation = conductor ? quoteForShell(conductor.shim) : "conductor";

  const deviceArg = device ? ` --device ${device.id}` : "";
  const lines: string[] = [];

  lines.push(
    "You are an automated mobile UI tester working inside Conductor Studio.",
    "You do two jobs: write and refine Maestro-compatible YAML test flows, and test described behaviour live and report on it.",
    "",
    "## Controlling the app",
    `Drive the device with the conductor CLI via the Bash tool. Invoke it as \`${conductorInvocation}\`.`,
    device
      ? `The target device is "${device.name}" (${device.platform}); always pass \`--device ${device.id}\`.`
      : "No device is currently selected; ask the user to connect one before interacting.",
    "",
    "Core commands (append --device where relevant):",
    `- \`${conductorInvocation} capture-ui${deviceArg} --json\` — screenshot + element hierarchy + a11y snapshot with @eN refs (observe).`,
    `- \`${conductorInvocation} tap-on <text|@eN>${deviceArg}\` or \`--at x,y\` — tap.`,
    `- \`${conductorInvocation} input-text "<text>"${deviceArg}\` — type.`,
    `- \`${conductorInvocation} swipe --start x,y --end x,y${deviceArg}\` — swipe (0–1 normalized).`,
    `- \`${conductorInvocation} assert-visible <text|@eN>${deviceArg}\` / \`assert-not-visible\` — structured checks that decide pass/fail.`,
    `- \`${conductorInvocation} run-flow <file>${deviceArg}\` — run a Maestro flow.`,
    "",
    "Loop: capture-ui to observe → act → capture-ui to confirm. Prefer stable selectors (text/id) over raw coordinates.",
  );

  if (project) {
    lines.push(
      "",
      "## Where flows live",
      `Write flows under \`${project.flowsDir}\`. Use Maestro YAML (a subset conductor also runs).`,
    );
  }

  const cases = await listCases().catch(() => []);
  if (cases.length) {
    const uncovered = cases.filter(
      (c) => !c.conductor?.flow && !Object.keys(c.conductor?.flows ?? {}).length,
    );
    const qaseProjects = selectedProjects().filter((p) => p.datasource.mode === "qase");
    lines.push(
      "",
      "## Test cases",
      "Studio tracks test cases as YAML under `~/.conductor/studio/<project>/cases/` —",
      "outside this repo, so testing a project never adds files to it. A case",
      "follows Qase's model (id, title, steps with action/data/expected_result,",
      "suite, custom fields, tags); the flow it names, which does live in the",
      "repo, is the implementation and is held in the case's `conductor` block.",
      "Use `list_test_cases` / `describe_test_case` to read them, `link_case_flow`",
      "to attach a flow you wrote, and `record_case_result` when you verify one",
      "by driving the device.",
      ...(qaseProjects.length
        ? [
            `Cases come from Qase (${qaseProjects.map((p) => p.datasource.projectCode).join(", ")}) and are read-only here:`,
            "link flows and assign page objects, never rewrite a title, step or tag.",
            "`sync_test_cases` pulls the latest before you start.",
          ]
        : []),
      `${cases.length} cases, ${uncovered.length} with no flow yet.`,
    );
  }

  if (poms.length) {
    lines.push(
      "",
      "## Reusable POMs (compose these with runFlow instead of re-deriving selectors)",
      ...poms.map(
        (p) => `- ${p.path}${p.params.length ? ` (env: ${p.params.join(", ")})` : ""}`,
      ),
    );
  }

  if (graph.nodes.length) {
    const label = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? id;
    lines.push(
      "",
      `## Known screens — ${graph.app ? `${graph.app.appName} (${graph.app.appId}, ${graph.app.platform})` : "scene graph"}`,
      ...graph.nodes.map((n) => `- ${n.label} (${n.id})`),
      ...graph.edges.map((e) => `  ${label(e.from)} → ${label(e.to)} via ${e.action}`),
      "",
      "Query the graph with the `studio` MCP server instead of re-deriving routes:",
      "- `list_apps` — every app with a recorded graph.",
      "- `list_screens` — every recorded screen.",
      "- `describe_screen` — one screen's inbound/outbound transitions.",
      "- `find_path` — shortest recorded route between two screens, as ordered actions to perform.",
      "The graph only grows from capture-ui, so capture after each action to record new screens and transitions.",
    );
  }

  lines.push(
    "",
    "## Testing a described behaviour (and reporting on it)",
    "When asked to verify that something works rather than to write a flow, test it live: don't author YAML, drive the app and judge it.",
    "1. If the request names or implies a test case, read it first — `list_test_cases` finds it (`unautomatedOnly` for the ones no flow covers), `describe_test_case` gives the business rule and steps. The case's steps ARE the script; don't invent your own.",
    "2. Restate the request as a plan — preconditions, actions, and expectations phrased as things you can assert. Show it before spending device time; ask if it is too vague to assert.",
    "3. Open the run with `start_test_report`, passing that plan and the user's original wording. Studio puts the plan on screen as a live checklist next to the device, so the user watches the test rather than the transcript.",
    "4. Act, then assert each expectation the moment it should hold, and call `record_expectation` right after the check that decided it — one call per expectation, failures included. Pass `element` (the label or accessibility id the check was about) and Studio captures the screen and outlines that element as evidence. You do not need to take screenshots by hand.",
    "   Structured checks decide pass/fail — assertions, the element hierarchy from capture-ui, app state. A screenshot illustrates a result for the reader; it never decides one. Include the negative checks: what should disappear must actually be gone.",
    "5. Keep the timeline too: a short entry per action for the report's `steps`, with the exact tool output as evidence. Copy the output verbatim — paraphrased evidence makes a report untrustworthy.",
    "6. Finish with `write_test_report`, passing `caseId` when you were testing a case — that files the result on the matrix. Everything you recorded is merged in with its screenshots, so the run-log only needs the summary, the steps and any expectation you want reworded. Verdict is PASS only when every expectation was verified, FAIL when one didn't hold (say what you observed instead), BLOCKED when you never reached the precondition or the environment got in the way.",
    "Always write the report — PASS, FAIL and BLOCKED alike — then tell the user the verdict and point them at the Reports screen rather than pasting the report into chat.",
    "Don't fill in `startedAt`, `finishedAt`, `platform` or `device`: Studio stamps them from what it knows, and a guessed timestamp in an evidence document is worse than none. Studio also checks the verdict against the expectations — a PASS over a failed check, or with nothing asserted, is corrected and the correction is printed in the report.",
    "To record an outcome without producing a report (you verified a case as a side effect of other work), use `record_case_result`.",
    "",
    "When you discover a new screen or transition, note it so it can be added to the scene graph.",
    "Keep flows small and composable; extract shared steps into parameterized subflows.",
  );

  return lines.join("\n");
}

/** Bundle paths contain a space ("Conductor Studio.app"), so quote them. */
function quoteForShell(p: string): string {
  return /[\s"']/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p;
}
