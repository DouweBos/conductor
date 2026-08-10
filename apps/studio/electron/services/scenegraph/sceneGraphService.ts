import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type {
  AppFingerprint,
  CaptureElement,
  CaptureUiResult,
  SceneGraph,
  SceneGraphSummary,
} from "../../../app/lib/types";
import { broadcastToRenderers } from "../../broadcast";
import { appState } from "../../state";
import { SceneGraphIndex } from "./graph";

/**
 * Scene graphs live outside the repo, keyed by the app they describe — the same
 * app explored from two checkouts shares one graph, and no test-run artefact
 * lands in the user's working tree.
 */
const GRAPHS_DIR = path.join(homedir(), ".conductor", "studio", "scenegraphs");

function graphPath(key: string): string {
  return path.join(GRAPHS_DIR, `${key}.json`);
}

/**
 * Bumped when signatures change shape. Nodes recorded under an older scheme
 * can't be matched against new captures, so they're dropped rather than left to
 * accumulate a duplicate per visit.
 */
const GRAPH_VERSION = 2;

function emptyGraph(app?: AppFingerprint): SceneGraph {
  return { version: GRAPH_VERSION, app, nodes: [], edges: [] };
}

const graphs = new Map<string, SceneGraph>();
const indexes = new Map<string, SceneGraphIndex>();
/** Previously-seen screen per app, so a transition edge knows where it came from. */
const cursors = new Map<string, string>();

/** The app the last capture identified; scene graph reads default to it. */
export function currentApp(): AppFingerprint | null {
  return appState.currentApp;
}

async function readGraph(app: AppFingerprint): Promise<SceneGraph> {
  const cached = graphs.get(app.key);
  if (cached) return cached;

  let graph = emptyGraph(app);
  const abs = graphPath(app.key);
  if (existsSync(abs)) {
    try {
      const parsed = JSON.parse(await readFile(abs, "utf8")) as SceneGraph;
      const stale = (parsed.version ?? 1) < GRAPH_VERSION;
      graph = {
        version: GRAPH_VERSION,
        app: parsed.app ?? app,
        nodes: stale || !Array.isArray(parsed.nodes) ? [] : parsed.nodes,
        edges: stale || !Array.isArray(parsed.edges) ? [] : parsed.edges,
      };
    } catch {
      // corrupt file — start fresh rather than losing the session
    }
  }
  graphs.set(app.key, graph);
  return graph;
}

/** The graph for an app, or the current app's when omitted. */
export async function loadSceneGraph(app?: AppFingerprint | null): Promise<SceneGraph> {
  const target = app ?? appState.currentApp;
  if (!target) return emptyGraph();
  return readGraph(target);
}

/** Adjacency-indexed graph for traversal (MCP path-finding). Cached per write. */
export async function getSceneGraphIndex(app?: AppFingerprint | null): Promise<SceneGraphIndex> {
  const target = app ?? appState.currentApp;
  if (!target) return new SceneGraphIndex(emptyGraph());
  const cached = indexes.get(target.key);
  if (cached) return cached;
  const index = new SceneGraphIndex(await readGraph(target));
  indexes.set(target.key, index);
  return index;
}

/** Every recorded app, newest file content first read from disk. */
export async function listSceneGraphs(): Promise<SceneGraphSummary[]> {
  let files: string[] = [];
  try {
    files = (await readdir(GRAPHS_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const summaries: SceneGraphSummary[] = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(await readFile(path.join(GRAPHS_DIR, file), "utf8")) as SceneGraph;
      const key = path.basename(file, ".json");
      summaries.push({
        key,
        app: parsed.app ?? { appId: key, appName: key, platform: "ios", key },
        screens: parsed.nodes?.length ?? 0,
        transitions: parsed.edges?.length ?? 0,
      });
    } catch {
      // skip unreadable graphs
    }
  }
  return summaries.sort((a, b) => a.app.appName.localeCompare(b.app.appName));
}

/** Look up a graph by storage key (what MCP callers pass). */
export async function findAppByKey(key: string): Promise<AppFingerprint | null> {
  if (appState.currentApp?.key === key) return appState.currentApp;
  const match = (await listSceneGraphs()).find(
    (s) => s.key === key || s.app.appId === key || s.app.appName.toLowerCase() === key.toLowerCase(),
  );
  return match?.app ?? null;
}

/**
 * Text that changes on its own — the status bar. Including it would make every
 * capture a minute apart look like a different screen.
 */
const VOLATILE = [
  /^\d{1,2}:\d{2}(\s*[AP]M)?$/i,
  /battery/i,
  /wi-?fi/i,
  /^cellular$/i,
  /^SSID/i,
  /^\d+%$/,
  /signal strength/i,
  /^no service$/i,
];

function isVolatile(text: string): boolean {
  return VOLATILE.some((pattern) => pattern.test(text));
}

/** Every element in the capture, depth first. */
function walk(element: CaptureElement, into: CaptureElement[] = []): CaptureElement[] {
  for (const child of element.children ?? []) {
    into.push(child);
    walk(child, into);
  }
  return into;
}

/**
 * A stable signature for a screen. The whole tree contributes — the app's
 * content is nested under its window, so only looking at the top level saw the
 * status bar and nothing else — and self-changing text is left out, sorted so
 * revisiting a screen dedups to one node.
 */
export function signatureFor(capture: CaptureUiResult): string {
  const tokens = walk(capture.root)
    .map((el) => ({ role: el.role ?? "", text: (el.text ?? "").trim().slice(0, 24) }))
    .filter(({ role, text }) => (role || text) && !isVolatile(text))
    .map(({ role, text }) => `${role}:${text}`)
    .sort();
  return [...new Set(tokens)].join("|");
}

/** A screen's name: the first stable, short label a leaf carries. */
function labelFor(capture: CaptureUiResult, index: number): string {
  const text = walk(capture.root).find(
    (el) =>
      (el.children ?? []).length === 0 &&
      !!el.text?.trim() &&
      el.text.trim().length <= 24 &&
      !isVolatile(el.text.trim()),
  );
  return text?.text?.trim() ?? `Screen ${index}`;
}

async function persist(graph: SceneGraph, key: string): Promise<void> {
  indexes.delete(key);
  const abs = graphPath(key);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
}

/**
 * Record a capture as a screen node, and (if an action preceded it) a transition
 * edge from the previously-seen screen. Called from every capture-ui; a capture
 * we can't attribute to an app is dropped rather than filed under the wrong one.
 */
export async function recordCapture(
  capture: CaptureUiResult,
  action: string | null,
  app: AppFingerprint | null,
): Promise<void> {
  if (!app) return;
  const signature = signatureFor(capture);
  if (!signature) return;

  const graph = await readGraph(app);
  graph.app = app;
  let node = graph.nodes.find((n) => n.signature === signature);
  if (!node) {
    node = {
      id: `screen-${graph.nodes.length + 1}`,
      label: labelFor(capture, graph.nodes.length + 1),
      signature,
    };
    graph.nodes.push(node);
  }

  const lastNodeId = cursors.get(app.key);
  if (lastNodeId && action && lastNodeId !== node.id) {
    const exists = graph.edges.some(
      (e) => e.from === lastNodeId && e.to === node!.id && e.action === action,
    );
    if (!exists) graph.edges.push({ from: lastNodeId, to: node.id, action });
  }
  cursors.set(app.key, node.id);

  try {
    await persist(graph, app.key);
  } catch {
    // best-effort persistence
  }
  broadcastToRenderers("scenegraph:updated", graph);
}
