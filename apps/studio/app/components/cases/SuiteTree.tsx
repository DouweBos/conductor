import { TreeView, type TreeNode } from "@conductor/studio-ui";
import { useMemo } from "react";

import type { Case } from "../../lib/types";
import styles from "./CasesView.module.css";

/** Cases Qase filed under no suite still need somewhere to live. */
const UNFILED = "Unfiled";

export const ALL_SUITES = "";

/** The suites a case belongs to, root first. */
export function suitePathOf(c: Case): string[] {
  if (c.suite_path?.length) return c.suite_path;
  return c.suite ? [c.suite] : [UNFILED];
}

/** `RN (Mobile)/Community` — the selection, and a tree node's id. */
export function suiteKey(path: string[]): string {
  return path.join("/");
}

/** Does this case sit in the selected suite, or one below it? */
export function inSuite(c: Case, selected: string): boolean {
  if (selected === ALL_SUITES) return true;
  const key = suiteKey(suitePathOf(c));
  return key === selected || key.startsWith(`${selected}/`);
}

interface Node {
  path: string[];
  children: Map<string, Node>;
  /** Cases in this suite and every suite under it — what the count means. */
  total: number;
}

function build(cases: Case[]): Node {
  const root: Node = { path: [], children: new Map(), total: cases.length };
  for (const c of cases) {
    let node = root;
    for (const title of suitePathOf(c)) {
      const child = node.children.get(title) ?? {
        path: [...node.path, title],
        children: new Map(),
        total: 0,
      };
      child.total += 1;
      node.children.set(title, child);
      node = child;
    }
  }
  return root;
}

function toNodes(node: Node): TreeNode[] {
  return [...node.children.values()]
    .sort((a, b) => {
      const [x, y] = [a.path[a.path.length - 1], b.path[b.path.length - 1]];
      // Unfiled is a bucket, not a suite — it sorts last wherever it appears.
      return x === UNFILED ? 1 : y === UNFILED ? -1 : x.localeCompare(y);
    })
    .map((child) => ({
      id: suiteKey(child.path),
      label: child.path[child.path.length - 1],
      icon: "folder" as const,
      meta: String(child.total),
      children: child.children.size ? toNodes(child) : undefined,
    }));
}

/**
 * Qase's own suite folders, as the way into the matrix. A repo's cases are
 * nested three or four deep, so the tree is the table of contents the flat list
 * never was — picking a suite scopes the matrix to it and everything under it.
 */
export function SuiteTree({
  cases,
  selected,
  onSelect,
}: {
  cases: Case[];
  selected: string;
  onSelect: (key: string) => void;
}) {
  const root = useMemo(() => build(cases), [cases]);
  const nodes = useMemo(
    () => [
      { id: ALL_SUITES, label: "All cases", icon: "matrix" as const, meta: String(root.total) },
      ...toNodes(root),
    ],
    [root],
  );

  return (
    <div className={styles.suites}>
      <TreeView
        nodes={nodes}
        selectedId={selected}
        onSelect={onSelect}
        defaultExpandedIds={nodes.slice(1, 2).map((n) => n.id)}
      />
    </div>
  );
}
