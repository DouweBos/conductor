import type { DeviceInfo } from "../../../app/lib/types";
import { getProjectInfo } from "../file/fileService";
import { listPoms } from "../pom/pomService";
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
  const [poms, graph, conductor] = await Promise.all([
    listPoms().catch(() => []),
    loadSceneGraph().catch(() => ({ version: 1, nodes: [], edges: [] })),
    resolveConductor().catch(() => null),
  ]);

  const conductorInvocation = conductor
    ? conductor.prefixArgs.length
      ? `${conductor.bin} ${conductor.prefixArgs.join(" ")}`
      : conductor.bin
    : "conductor";

  const deviceArg = device ? ` --device ${device.id}` : "";
  const lines: string[] = [];

  lines.push(
    "You are an automated mobile UI test author working inside Conductor Studio.",
    "Your job is to explore the app, then write and refine Maestro-compatible YAML test flows.",
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
    lines.push(
      "",
      "## Known screens (scene graph — use to navigate without re-exploring)",
      ...graph.nodes.map((n) => `- ${n.label}`),
      ...graph.edges.map((e) => `  ${e.from} → ${e.to} via ${e.action}`),
    );
  }

  lines.push(
    "",
    "When you discover a new screen or transition, note it so it can be added to the scene graph.",
    "Keep flows small and composable; extract shared steps into parameterized subflows.",
  );

  return lines.join("\n");
}
