import { readFile } from "node:fs/promises";
import path from "node:path";

import { datasource } from "./casesService";
import type { Case } from "./model";
import { getProjectInfo } from "../file/fileService";
import { loadFlowCatalog } from "../flow/catalog";
import { listSceneGraphs } from "../scenegraph/sceneGraphService";
import { listCases } from "./casesService";

/**
 * Everything an agent would otherwise spend twenty minutes rediscovering before
 * it can write the flow for a case: the spec, the same case's flow on the other
 * platform, the conventions that flow follows, the page objects that already do
 * the work, and the screens the app is known to have.
 *
 * Assembled here rather than in the prompt because only the main process can
 * read the repo, the flow catalog and the scene graph.
 */

const MAX_REFERENCE_LINES = 160;

export async function automationBrief(ref: string, column?: string): Promise<string> {
  const project = getProjectInfo();
  if (!project) throw new Error("No project is open.");
  const cases = await listCases();
  const testCase = cases.find((c) => c.ref === ref);
  if (!testCase) throw new Error(`No case ${ref}.`);

  // Default to a matrix column this case has no flow for yet.
  const field = datasource().qase?.matrixField;
  const columns = field ? (testCase.custom_fields[field] ?? []) : [];
  const target = column ?? columns.find((p) => !testCase.conductor?.flows?.[p]);
  const lines: string[] = [
    `Write the Maestro flow for test case ${testCase.ref}${target ? ` (${target})` : ""} — "${testCase.title}".`,
    "",
    "Everything you need is below: the case, the same case's flow on the other",
    "platform, the conventions it follows, the page objects that already exist,",
    "and the screens we know about. Read it before touching the device.",
  ];

  lines.push(...caseSection(testCase, target));
  lines.push(...(await referenceSection(testCase, target, project.flowsDir)));
  lines.push(...(await pomSection(testCase)));
  lines.push(...(await screensSection()));
  lines.push(...instructions(testCase, target));
  return lines.join("\n");
}

function caseSection(c: Case, column?: string): string[] {
  const lines = ["", "## The case", "", `Id: ${c.ref}${c.suite ? ` (suite: ${c.suite})` : ""}`];
  if (c.description) lines.push(`Business rule: ${c.description}`);
  const facets = [
    ...Object.entries(c.custom_fields).map(([field, values]) => `${field}=${values.join("/")}`),
    ...(c.tags.length ? [`tags=${c.tags.join("/")}`] : []),
  ].join(" · ");
  if (facets) lines.push(`Tags: ${facets}`);
  if (c.preconditions) lines.push("", "Preconditions:", c.preconditions);
  if (c.steps?.length) {
    lines.push("", "Steps — this is the script, don't invent your own:");
    c.steps.forEach((step, i) => {
      const bits = [`${i + 1}. ${step.action}`];
      if (step.data) bits.push(`   data: ${step.data}`);
      if (step.expected_result) bits.push(`   expect: ${step.expected_result}`);
      if (step.pom) {
        const env = step.env ? ` with env ${JSON.stringify(step.env)}` : "";
        bits.push(`   the case says this is \`${step.pom}\`${env} — use it`);
      }
      lines.push(...bits);
    });
  }
  if (c.postconditions) lines.push("", "Postconditions:", c.postconditions);
  if (column && c.conductor?.flows) {
    const others = Object.entries(c.conductor.flows).filter(([key]) => key !== column);
    if (others.length) {
      lines.push("", `Already automated elsewhere: ${others.map(([k, v]) => `${k} → ${v}`).join(", ")}`);
    }
  }
  return lines;
}

/**
 * The same case on another platform is the best reference there is: same
 * assertions, same data, same hooks — only the interaction model differs.
 * Failing that, a neighbouring flow for the target platform shows the house
 * style.
 */
async function referenceSection(c: Case, column: string | undefined, flowsDir: string): Promise<string[]> {
  const wiring = c.conductor;
  const sibling = Object.entries(wiring?.flows ?? {}).find(([key]) => key !== column)?.[1] ?? wiring?.flow;
  const fallback = sibling ? undefined : await neighbourFlow(column);
  const reference = sibling ?? fallback;
  if (!reference) return [];

  let content: string;
  try {
    content = await readFile(path.resolve(flowsDir, reference), "utf8");
  } catch {
    return [];
  }
  const trimmed = content.split("\n").slice(0, MAX_REFERENCE_LINES).join("\n");
  return [
    "",
    sibling ? "## The same case on another platform" : "## A neighbouring flow, for the house style",
    "",
    sibling
      ? `\`${reference}\` implements this case elsewhere. Mirror its structure, its hooks, its test data and its assertions; change only what the platform forces you to change.`
      : `\`${reference}\` is a flow for this platform. Follow its header, hooks and tag conventions.`,
    "",
    "```yaml",
    trimmed,
    content.split("\n").length > MAX_REFERENCE_LINES ? "# … truncated, read the file for the rest" : "",
    "```",
  ].filter(Boolean);
}

/** A flow already written for the target platform, preferring the same feature. */
async function neighbourFlow(column?: string): Promise<string | undefined> {
  const catalog = await loadFlowCatalog();
  const flows = catalog.entries.filter((e) => e.kind === "flow" && e.path.startsWith("flows/"));
  if (!column) return flows[0]?.path;
  const suffix = column === "mobile" ? ".responsive." : `.${column}.`;
  return (flows.find((e) => e.path.includes(suffix)) ?? flows[0])?.path;
}

async function pomSection(c: Case): Promise<string[]> {
  const catalog = await loadFlowCatalog();
  const poms = catalog.entries.filter((e) => e.kind === "flow" && /^(pages|commands)\//.test(e.path));
  if (!poms.length) return [];

  const named = new Set((c.steps ?? []).map((s) => s.pom).filter(Boolean) as string[]);
  const describe = (p: (typeof poms)[number]) =>
    `- \`${p.alias ?? p.path}\`${p.params.length ? ` (env: ${p.params.join(", ")})` : ""}`;
  const lines = ["", "## Page objects — compose these, don't re-derive selectors", ""];
  if (named.size) {
    lines.push(
      "The case's steps name these directly:",
      ...poms.filter((p) => named.has(p.path)).map(describe),
      "",
      "Everything else available:",
    );
  }
  lines.push(...poms.filter((p) => !named.has(p.path)).map(describe));
  return lines;
}

async function screensSection(): Promise<string[]> {
  const graphs = await listSceneGraphs().catch(() => []);
  if (!graphs.length) return [];
  return [
    "",
    "## Known screens",
    "",
    `The scene graph has ${graphs.map((g) => `${g.app.appName ?? g.app.appId} (${g.screens} screens)`).join(", ")}.`,
    "Use `list_screens`, `describe_screen` and `find_path` to navigate instead of exploring by trial and error.",
  ];
}

function instructions(c: Case, column?: string): string[] {
  return [
    "",
    "## How to go about it",
    "",
    `1. \`scaffold_case_flow\` with ref "${c.ref}"${column ? ` and column "${column}"` : ""} — it writes the skeleton from the steps (page objects become runFlow calls, the rest become TODOs) and links it to the case.`,
    "2. Fill in the TODOs. Reuse page objects wherever one covers a step; write a new one under `pages/` if a step is worth reusing and none exists.",
    "3. Run it on the device until it passes twice in a row. Use `conductor run-flow <file> --device <id>` and read the failures rather than guessing.",
    "4. Keep the draft tag until it's green twice; only then promote it to the suite's real tag.",
    `5. Finish with \`record_case_result\` for ${c.ref}${column ? ` (column "${column}")` : ""} so the matrix reflects reality.`,
    "",
    "Don't weaken an assertion to make a flow pass — if the app is wrong, say so and stop.",
  ];
}
