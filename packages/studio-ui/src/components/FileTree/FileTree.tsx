import { useMemo } from "react";

import type { IconName } from "../../icons/Icons";
import { TreeView, type TreeNode } from "../TreeView/TreeView";

export interface FileEntry {
  /** Path relative to the flows root, used as the stable id. */
  path: string;
  name: string;
  type: "file" | "dir";
  children?: FileEntry[];
}

export interface FileTreeProps {
  entries: FileEntry[];
  selectedPath?: string | null;
  onSelectFile?: (path: string) => void;
  onContextMenu?: (path: string, x: number, y: number) => void;
}

function iconFor(entry: FileEntry): IconName {
  if (entry.type === "dir") return "folder";
  if (entry.name.endsWith(".js") || entry.name.endsWith(".ts")) return "code";
  return "file";
}

function toNodes(entries: FileEntry[]): TreeNode[] {
  return entries.map((entry) => ({
    id: entry.path,
    label: entry.name,
    icon: iconFor(entry),
    children: entry.children ? toNodes(entry.children) : undefined,
  }));
}

export function FileTree({ entries, selectedPath, onSelectFile, onContextMenu }: FileTreeProps) {
  const nodes = useMemo(() => toNodes(entries), [entries]);
  const filePaths = useMemo(() => collectFilePaths(entries), [entries]);

  return (
    <TreeView
      nodes={nodes}
      selectedId={selectedPath}
      expandAll
      onSelect={(id) => {
        if (filePaths.has(id)) onSelectFile?.(id);
      }}
      onContextMenu={onContextMenu}
    />
  );
}

function collectFilePaths(entries: FileEntry[]): Set<string> {
  const set = new Set<string>();
  const walk = (list: FileEntry[]) => {
    for (const e of list) {
      if (e.type === "file") set.add(e.path);
      if (e.children) walk(e.children);
    }
  };
  walk(entries);
  return set;
}
