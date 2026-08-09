import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { CaptureUiResult, SceneGraph } from "../../../app/lib/types";
import { getProjectInfo } from "../file/fileService";

const GRAPH_FILE = path.join(".conductor-studio", "scenegraph.json");
const EMPTY: SceneGraph = { version: 1, nodes: [], edges: [] };

function graphPath(): string {
  const project = getProjectInfo();
  if (!project) throw new Error("No project is open.");
  return path.join(project.root, GRAPH_FILE);
}

/**
 * Load the git-tracked scene graph. Later agentic runs seed themselves from this
 * map of discovered screens to cut orientation time. Building the graph live
 * (from capture-ui snapshots via `signatureFor`) is a follow-on.
 */
export async function loadSceneGraph(): Promise<SceneGraph> {
  const project = getProjectInfo();
  if (!project) return EMPTY;
  const abs = graphPath();
  if (!existsSync(abs)) return EMPTY;
  try {
    const parsed = JSON.parse(await readFile(abs, "utf8")) as SceneGraph;
    return {
      version: parsed.version ?? 1,
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    };
  } catch {
    return EMPTY;
  }
}

/**
 * Derive a stable signature for a screen from its capture-ui result, used to
 * dedup nodes when building the graph. Sorted role+text set → order-independent.
 */
export function signatureFor(capture: CaptureUiResult): string {
  const tokens = (capture.root.children ?? [])
    .map((el) => `${el.role ?? ""}:${(el.text ?? "").slice(0, 24)}`)
    .filter((t) => t !== ":")
    .sort();
  return tokens.join("|");
}
