import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CaptureUiResult, SceneGraph } from "../../../app/lib/types";
import { broadcastToRenderers } from "../../broadcast";
import { getProjectInfo } from "../file/fileService";

const GRAPH_FILE = path.join(".conductor-studio", "scenegraph.json");

function graphPath(): string {
  const project = getProjectInfo();
  if (!project) throw new Error("No project is open.");
  return path.join(project.root, GRAPH_FILE);
}

/** Load the git-tracked scene graph (fresh objects — never a shared constant). */
export async function loadSceneGraph(): Promise<SceneGraph> {
  const project = getProjectInfo();
  if (!project) return { version: 1, nodes: [], edges: [] };
  const abs = graphPath();
  if (!existsSync(abs)) return { version: 1, nodes: [], edges: [] };
  try {
    const parsed = JSON.parse(await readFile(abs, "utf8")) as SceneGraph;
    return {
      version: parsed.version ?? 1,
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    };
  } catch {
    return { version: 1, nodes: [], edges: [] };
  }
}

/**
 * Derive a stable signature for a screen from its capture-ui result. Sorted
 * role+text set → order-independent, so revisiting a screen dedups to one node.
 */
export function signatureFor(capture: CaptureUiResult): string {
  const tokens = (capture.root.children ?? [])
    .map((el) => `${el.role ?? ""}:${(el.text ?? "").slice(0, 24)}`)
    .filter((t) => t !== ":")
    .sort();
  return tokens.join("|");
}

// ── Live builder ──────────────────────────────────────────────────────────
let mem: SceneGraph | null = null;
let lastNodeId: string | null = null;

async function ensureLoaded(): Promise<SceneGraph> {
  if (!mem) mem = await loadSceneGraph();
  return mem;
}

function labelFor(capture: CaptureUiResult, index: number): string {
  const texts = (capture.root.children ?? [])
    .map((el) => el.text?.trim())
    .filter((t): t is string => !!t && t.length <= 24);
  return texts[0] ?? `Screen ${index}`;
}

async function persist(graph: SceneGraph): Promise<void> {
  const abs = graphPath();
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
}

/**
 * Record a capture as a screen node, and (if an action preceded it) a transition
 * edge from the previously-seen screen. Persists to the git-tracked graph and
 * broadcasts the update. Called from every capture-ui.
 */
export async function recordCapture(
  capture: CaptureUiResult,
  action: string | null,
): Promise<void> {
  const project = getProjectInfo();
  if (!project) return;
  const signature = signatureFor(capture);
  if (!signature) return;

  const graph = await ensureLoaded();
  let node = graph.nodes.find((n) => n.signature === signature);
  if (!node) {
    node = {
      id: `screen-${graph.nodes.length + 1}`,
      label: labelFor(capture, graph.nodes.length + 1),
      signature,
    };
    graph.nodes.push(node);
  }

  if (lastNodeId && action && lastNodeId !== node.id) {
    const exists = graph.edges.some(
      (e) => e.from === lastNodeId && e.to === node!.id && e.action === action,
    );
    if (!exists) graph.edges.push({ from: lastNodeId, to: node.id, action });
  }
  lastNodeId = node.id;

  try {
    await persist(graph);
  } catch {
    // best-effort persistence
  }
  broadcastToRenderers("scenegraph:updated", graph);
}

/** Reset the in-memory cursor (e.g. when switching devices/projects). */
export function resetSceneCursor(): void {
  lastNodeId = null;
  mem = null;
}
