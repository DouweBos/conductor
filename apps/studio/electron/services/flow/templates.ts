import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { FlowTemplate } from "../../../app/lib/types";
import { createFlow, flattenFiles, getProjectInfo, listFlows, readFlow } from "../file/fileService";

/**
 * Scaffolds for new flows. A template is a flow with `{{placeholders}}` —
 * `${…}` belongs to Maestro at run time, so scaffold-time substitution needs
 * its own syntax.
 *
 * They live in `<flowsDir>/.templates/*.yaml.tmpl`. The `.tmpl` suffix is what
 * keeps them out of runs: every flow scanner (maestro's workspace glob, our
 * folder runner, the file tree) matches on a `.yaml`/`.yml`/`.js` extension, so
 * a template is invisible to all of them without any `config.yaml` exclusion.
 */

const TEMPLATE_DIR = ".templates";
const SUFFIX = ".yaml.tmpl";
const PLACEHOLDER = /\{\{\s*([a-zA-Z][\w]*)\s*\}\}/g;

/** Filled in automatically — the dialog only asks for what's left. */
const AUTO_VARS = new Set(["name", "path", "dir", "appId", "date"]);

const BUILT_INS: { id: string; label: string; body: string }[] = [
  {
    id: "blank",
    label: "Blank flow",
    body: `# An empty flow.
appId: {{appId}}
---
- launchApp
`,
  },
  {
    id: "page",
    label: "Page object subflow",
    body: `# A reusable subflow: one screen, one action. Call it with runFlow.
appId: {{appId}}
env:
  {{param}}: ""
---
- assertVisible: "{{name}}"
`,
  },
  {
    id: "case",
    label: "Tagged test case",
    body: `# A test case, tagged so suites can select it.
appId: {{appId}}
tags:
  - {{tag}}
---
- launchApp:
    clearState: true
`,
  },
];

export async function listTemplates(): Promise<FlowTemplate[]> {
  const own = await readProjectTemplates();
  const ids = new Set(own.map((t) => t.id));
  const builtIn = BUILT_INS.filter((t) => !ids.has(t.id)).map((t) => ({
    id: t.id,
    label: t.label,
    description: describe(t.body),
    vars: varsIn(t.body),
    builtIn: true,
  }));
  return [...own, ...builtIn];
}

/** Create `relPath` from a template, filling `vars` plus the automatic ones. */
export async function createFromTemplate(
  templateId: string,
  relPath: string,
  vars: Record<string, string>,
): Promise<void> {
  const body = await templateBody(templateId);
  if (body === null) throw new Error(`No such template: ${templateId}`);
  await createFlow(relPath, render(body, { ...(await autoVars(relPath)), ...vars }));
}

/** Substitute `{{var}}`. Unknown placeholders stay put — they read as "fill me in". */
export function render(body: string, vars: Record<string, string>): string {
  return body.replace(PLACEHOLDER, (match, name: string) => vars[name] ?? match);
}

async function templateBody(id: string): Promise<string | null> {
  const project = getProjectInfo();
  if (project) {
    try {
      return await readFile(path.join(project.flowsDir, TEMPLATE_DIR, `${id}${SUFFIX}`), "utf8");
    } catch {
      // not a project template — fall through to the built-ins
    }
  }
  return BUILT_INS.find((t) => t.id === id)?.body ?? null;
}

async function readProjectTemplates(): Promise<FlowTemplate[]> {
  const project = getProjectInfo();
  if (!project) return [];
  const dir = path.join(project.flowsDir, TEMPLATE_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const templates: FlowTemplate[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(SUFFIX)) continue;
    const id = name.slice(0, -SUFFIX.length);
    const body = await readFile(path.join(dir, name), "utf8").catch(() => null);
    if (body === null) continue;
    templates.push({ id, label: humanize(id), description: describe(body), vars: varsIn(body), builtIn: false });
  }
  return templates;
}

/** The placeholders a caller still has to answer, in first-seen order. */
function varsIn(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(PLACEHOLDER)) {
    if (!AUTO_VARS.has(match[1])) seen.add(match[1]);
  }
  return [...seen];
}

/** A template's leading `#` comment is its description. */
function describe(body: string): string | undefined {
  const first = body.split(/\r?\n/, 1)[0]?.trim();
  return first?.startsWith("#") ? first.replace(/^#\s*/, "") : undefined;
}

function humanize(id: string): string {
  const words = id.replace(/[-_]/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

async function autoVars(relPath: string): Promise<Record<string, string>> {
  const dir = path.posix.dirname(relPath);
  return {
    name: path.posix.basename(relPath).replace(/\.(ya?ml|js|ts)$/, ""),
    path: relPath,
    dir: dir === "." ? "" : dir,
    date: new Date().toISOString().slice(0, 10),
    appId: (await inferAppId()) ?? "com.example.app",
  };
}

/**
 * The suite's app, taken from what its flows already declare — a new flow in a
 * suite that all targets one app should not ask.
 */
async function inferAppId(): Promise<string | undefined> {
  const counts = new Map<string, number>();
  for (const file of flattenFiles(await listFlows())) {
    if (!/\.ya?ml$/i.test(file.name)) continue;
    const declared = /^appId:\s*(\S+)/m.exec(await readFlow(file.path).catch(() => ""))?.[1];
    if (declared) counts.set(declared, (counts.get(declared) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}
