import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { aliasFor } from "../../../app/lib/flowRefs";
import type { FileEntry, FlowCatalog, FlowCatalogEntry } from "../../../app/lib/types";
import { getProjectInfo, listFlows } from "../file/fileService";

/**
 * The subflows and scripts a flow can call, with the parameters each expects.
 * POM suites are written by chaining subflows, so this is what the editor
 * completes against.
 *
 * Alias resolution mirrors conductor's `resolvePath`: `@name/rest` maps `name`
 * through `paths:` in the flows directory's `config.yaml`.
 */

const CONFIG_NAMES = ["config.yaml", "config.yml"];

export async function loadFlowCatalog(): Promise<FlowCatalog> {
  const project = getProjectInfo();
  if (!project) return { entries: [], aliases: {} };

  const aliases = readAliases(project.flowsDir);
  const files = flatten(await listFlows());
  const entries: FlowCatalogEntry[] = [];
  for (const file of files) {
    const isFlow = /\.(ya?ml)$/i.test(file.name);
    const isScript = /\.(js|ts)$/i.test(file.name);
    if (!isFlow && !isScript) continue;
    entries.push({
      path: file.path,
      alias: aliasFor(file.path, aliases),
      params: isFlow ? await envParams(path.join(project.flowsDir, file.path)) : [],
      kind: isFlow ? "flow" : "script",
    });
  }
  return { entries, aliases };
}

/** `paths:` from the flows directory's config.yaml, normalized to relative dirs. */
export function readAliases(flowsDir: string): Record<string, string> {
  for (const name of CONFIG_NAMES) {
    const configPath = path.join(flowsDir, name);
    if (!existsSync(configPath)) continue;
    try {
      const doc = parseYaml(readFileSync(configPath, "utf8")) as { paths?: Record<string, string> };
      const paths = doc?.paths;
      if (!paths || typeof paths !== "object") return {};
      const out: Record<string, string> = {};
      for (const [alias, target] of Object.entries(paths)) {
        // Relative to config.yaml, which sits at the flows root.
        out[alias] = path.normalize(String(target)).replace(/^\.\//, "").replace(/\/$/, "");
      }
      return out;
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * The parameters a subflow expects. They're rarely declared: the convention is
 * to just read `${param}` in the body, so infer from usage — a lower-camelCase
 * name with no dot. SCREAMING_SNAKE names (APP_ID, CI) are suite-wide globals
 * passed on the command line, and dotted ones are script output, not parameters.
 * Header `env:` keys count too, since those are declared outright.
 */
const NOT_PARAMS = new Set(["output", "response", "maestro", "console", "json"]);

async function envParams(absPath: string): Promise<string[]> {
  let content: string;
  try {
    content = await readFile(absPath, "utf8");
  } catch {
    return [];
  }
  const [header = "", ...rest] = content.split(/^---\s*$/m);
  const params: string[] = [];
  const add = (name: string) => {
    if (!params.includes(name)) params.push(name);
  };

  for (const key of declaredEnvKeys(header)) add(key);
  for (const match of rest.join("\n").matchAll(/\$\{\s*([A-Za-z_][\w.]*)/g)) {
    const name = match[1];
    if (name.includes(".") || NOT_PARAMS.has(name)) continue;
    if (!/^[a-z][A-Za-z0-9]*$/.test(name)) continue;
    add(name);
  }
  return params;
}

/** Keys of the flow's header `env:` block. */
function declaredEnvKeys(header: string): string[] {
  const lines = header.split(/\r?\n/);
  const keys: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^env:\s*$/.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) continue;
      if (/^\S/.test(line)) break;
      const key = /^\s+([A-Za-z_]\w*)\s*:/.exec(line);
      if (key) keys.push(key[1]);
    }
    break;
  }
  return keys;
}

function flatten(entries: FileEntry[]): FileEntry[] {
  const out: FileEntry[] = [];
  const walk = (list: FileEntry[]) => {
    for (const entry of list) {
      if (entry.type === "file") out.push(entry);
      if (entry.children) walk(entry.children);
    }
  };
  walk(entries);
  return out;
}
