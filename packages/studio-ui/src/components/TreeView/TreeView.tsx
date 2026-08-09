import { type ReactNode, useCallback, useMemo, useState } from "react";

import { Icon, type IconName } from "../../icons/Icons";
import styles from "./TreeView.module.css";

export interface TreeNode {
  id: string;
  label: ReactNode;
  icon?: IconName;
  children?: TreeNode[];
  /** Right-aligned trailing content (badge, count). */
  meta?: ReactNode;
}

export interface TreeViewProps {
  nodes: TreeNode[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onHover?: (id: string | null) => void;
  defaultExpandedIds?: string[];
  /** Fully expand every branch on mount. */
  expandAll?: boolean;
}

export function TreeView({
  nodes,
  selectedId,
  onSelect,
  onHover,
  defaultExpandedIds,
  expandAll,
}: TreeViewProps) {
  const allIds = useMemo(() => (expandAll ? collectIds(nodes) : []), [expandAll, nodes]);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set([...(defaultExpandedIds ?? []), ...allIds]),
  );

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <ul className={styles.tree} role="tree">
      {nodes.map((node) => (
        <TreeRow
          key={node.id}
          node={node}
          depth={0}
          expanded={expanded}
          toggle={toggle}
          selectedId={selectedId}
          onSelect={onSelect}
          onHover={onHover}
        />
      ))}
    </ul>
  );
}

interface RowProps {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  toggle: (id: string) => void;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onHover?: (id: string | null) => void;
}

function TreeRow({ node, depth, expanded, toggle, selectedId, onSelect, onHover }: RowProps) {
  const hasChildren = !!node.children?.length;
  const isOpen = expanded.has(node.id);
  const selected = selectedId === node.id;
  return (
    <li role="treeitem" aria-expanded={hasChildren ? isOpen : undefined}>
      <div
        className={[styles.row, selected && styles.selected].filter(Boolean).join(" ")}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => {
          onSelect?.(node.id);
          if (hasChildren) toggle(node.id);
        }}
        onMouseEnter={() => onHover?.(node.id)}
        onMouseLeave={() => onHover?.(null)}
      >
        <span className={styles.twisty}>
          {hasChildren ? (
            <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={12} />
          ) : null}
        </span>
        {node.icon ? <Icon name={node.icon} size={14} className={styles.icon} /> : null}
        <span className={styles.label}>{node.label}</span>
        {node.meta ? <span className={styles.meta}>{node.meta}</span> : null}
      </div>
      {hasChildren && isOpen ? (
        <ul className={styles.children} role="group">
          {node.children!.map((child) => (
            <TreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              toggle={toggle}
              selectedId={selectedId}
              onSelect={onSelect}
              onHover={onHover}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function collectIds(nodes: TreeNode[]): string[] {
  const ids: string[] = [];
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      ids.push(n.id);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return ids;
}
