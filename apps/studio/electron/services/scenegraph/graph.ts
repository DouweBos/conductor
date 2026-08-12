import type { SceneEdge, SceneGraph, SceneNode } from "../../../app/lib/types";

export interface PathStep {
  from: string;
  to: string;
  action: string;
}

export interface FoundPath {
  /** Node ids from start to goal, inclusive. */
  nodeIds: string[];
  steps: PathStep[];
  cost: number;
}

/**
 * Adjacency-indexed view of the persisted scene graph. Rebuilt from the JSON
 * whenever it changes — the graphs are small enough that indexing is cheaper
 * than keeping a mutable structure in sync.
 */
export class SceneGraphIndex {
  private readonly nodesById = new Map<string, SceneNode>();
  private readonly outgoing = new Map<string, SceneEdge[]>();
  private readonly incoming = new Map<string, SceneEdge[]>();

  constructor(graph: SceneGraph) {
    for (const node of graph.nodes) {
      this.nodesById.set(node.id, node);
      this.outgoing.set(node.id, []);
      this.incoming.set(node.id, []);
    }
    for (const edge of graph.edges) {
      // Skip edges pointing at screens that are no longer in the graph.
      if (!this.nodesById.has(edge.from) || !this.nodesById.has(edge.to)) continue;
      this.outgoing.get(edge.from)!.push(edge);
      this.incoming.get(edge.to)!.push(edge);
    }
  }

  get nodes(): SceneNode[] {
    return [...this.nodesById.values()];
  }

  node(id: string): SceneNode | null {
    return this.nodesById.get(id) ?? null;
  }

  edgesFrom(id: string): SceneEdge[] {
    return this.outgoing.get(id) ?? [];
  }

  edgesTo(id: string): SceneEdge[] {
    return this.incoming.get(id) ?? [];
  }

  /**
   * Resolve a screen the way an agent would name it: exact id, then exact
   * label, then a unique case-insensitive substring of either.
   */
  resolve(query: string): { node: SceneNode } | { candidates: SceneNode[] } {
    const exactId = this.nodesById.get(query);
    if (exactId) return { node: exactId };

    const q = query.trim().toLowerCase();
    const byLabel = this.nodes.filter((n) => n.label.toLowerCase() === q);
    if (byLabel.length === 1) return { node: byLabel[0] };
    if (byLabel.length > 1) return { candidates: byLabel };

    const partial = this.nodes.filter(
      (n) => n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q),
    );
    if (partial.length === 1) return { node: partial[0] };
    return { candidates: partial };
  }
}

/**
 * A* over the transition graph. Every edge costs 1 (one action to perform), and
 * the heuristic is the trivially admissible "0 at the goal, 1 elsewhere" — with
 * uniform costs there is no better lower bound available, so this behaves like
 * Dijkstra while keeping the frontier ordered by estimated total cost.
 */
export function findPath(
  index: SceneGraphIndex,
  startId: string,
  goalId: string,
  heuristic: (nodeId: string, goalId: string) => number = (id, goal) => (id === goal ? 0 : 1),
): FoundPath | null {
  if (!index.node(startId) || !index.node(goalId)) return null;
  if (startId === goalId) return { nodeIds: [startId], steps: [], cost: 0 };

  const gScore = new Map<string, number>([[startId, 0]]);
  const cameFrom = new Map<string, PathStep>();
  const open = new Set<string>([startId]);

  while (open.size) {
    let current = "";
    let best = Infinity;
    for (const id of open) {
      const f = (gScore.get(id) ?? Infinity) + heuristic(id, goalId);
      if (f < best) {
        best = f;
        current = id;
      }
    }

    if (current === goalId) return reconstruct(cameFrom, goalId, gScore.get(goalId) ?? 0);
    open.delete(current);

    for (const edge of index.edgesFrom(current)) {
      const tentative = (gScore.get(current) ?? Infinity) + 1;
      if (tentative >= (gScore.get(edge.to) ?? Infinity)) continue;
      gScore.set(edge.to, tentative);
      cameFrom.set(edge.to, { from: current, to: edge.to, action: edge.action });
      open.add(edge.to);
    }
  }

  return null;
}

function reconstruct(cameFrom: Map<string, PathStep>, goalId: string, cost: number): FoundPath {
  const steps: PathStep[] = [];
  let cursor = goalId;
  while (cameFrom.has(cursor)) {
    const step = cameFrom.get(cursor)!;
    steps.unshift(step);
    cursor = step.from;
  }
  return { nodeIds: [cursor, ...steps.map((s) => s.to)], steps, cost };
}
