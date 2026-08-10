import {
  Button,
  EmptyState,
  Select,
  Spinner,
  StatusPill,
  TextField,
  TreeView,
  type TreeNode,
} from "@conductor/studio-ui";
import { useEffect, useMemo, useState } from "react";

import { useIpcEvent } from "../../hooks/useIpcEvent";
import { loadSceneGraph } from "../../lib/ipc";
import { getCurrentRoute } from "../../lib/router";
import type { CaptureElement, SceneGraph } from "../../lib/types";
import { setBufferContent, useFlowBuffers } from "../../stores/flowStore";
import {
  findElement,
  refreshCapture,
  setSelectedRef,
  useCapture,
  useCaptureError,
  useCaptureLoading,
  useSelectedRef,
} from "../../stores/inspectStore";
import { SceneGraphDialog } from "./SceneGraphDialog";
import styles from "./Inspector.module.css";

/** Text a search matches against: id, label, role, ref. */
function haystack(el: CaptureElement): string {
  return [el.identifier, el.text, el.role, el.ref].filter(Boolean).join(" ").toLowerCase();
}

/**
 * Keep elements matching the query, and the ancestors that lead to them — a
 * capture runs to hundreds of nodes, so the tree is only usable filtered.
 */
function filterTree(elements: CaptureElement[], needle: string): CaptureElement[] {
  const out: CaptureElement[] = [];
  for (const el of elements) {
    const children = filterTree(el.children ?? [], needle);
    if (children.length > 0 || haystack(el).includes(needle)) out.push({ ...el, children });
  }
  return out;
}

function countElements(elements: CaptureElement[]): number {
  return elements.reduce((sum, el) => sum + 1 + countElements(el.children ?? []), 0);
}

function toNodes(elements: CaptureElement[]): TreeNode[] {
  return elements.map((el, i) => ({
    id: el.ref || `el-${i}`,
    label: el.text ? `${el.role ?? "Element"} “${el.text}”` : el.role || "Element",
    icon: "dot",
    meta: el.ref,
    children: el.children && el.children.length ? toNodes(el.children) : undefined,
  }));
}

export type CommandKind = "tapOn" | "assertVisible" | "inputText" | "longPressOn" | "copyTextFrom";

/** A selector fragment for the element, preferring text then id then point. */
function selectorFor(el: CaptureElement): string {
  if (el.text) return `"${el.text}"`;
  if (el.identifier) return `\n    id: "${el.identifier}"`;
  if (el.bounds) {
    return `\n    point: "${Math.round(el.bounds.x + el.bounds.width / 2)},${Math.round(
      el.bounds.y + el.bounds.height / 2,
    )}"`;
  }
  return `"${el.ref}"`;
}

/** Maestro command suggested for the selected element (Studio's signature feature). */
export function commandFor(el: CaptureElement, kind: CommandKind = "tapOn"): string {
  const sel = selectorFor(el);
  switch (kind) {
    case "assertVisible":
      return `- assertVisible: ${sel}`;
    case "longPressOn":
      return `- longPressOn: ${sel}`;
    case "inputText":
      return `- tapOn: ${sel}\n- inputText: "TODO"`;
    case "copyTextFrom":
      return `- copyTextFrom: ${sel}`;
    case "tapOn":
    default:
      return `- tapOn: ${sel}`;
  }
}

export function Inspector({ deviceId }: { deviceId: string | null }) {
  const capture = useCapture();
  const loading = useCaptureLoading();
  const error = useCaptureError();
  const selectedRef = useSelectedRef();
  const [graph, setGraph] = useState<SceneGraph | null>(null);
  const [graphOpen, setGraphOpen] = useState(false);
  const [kind, setKind] = useState<CommandKind>("tapOn");
  const buffers = useFlowBuffers();

  useEffect(() => {
    loadSceneGraph(deviceId ?? undefined).then(setGraph).catch(() => {});
  }, [deviceId]);
  useIpcEvent<SceneGraph>("scenegraph:updated", setGraph);

  const screenCount = graph?.nodes.length ?? 0;

  const [filter, setFilter] = useState("");
  const matched = useMemo(() => {
    const children = capture?.root.children ?? [];
    const needle = filter.trim().toLowerCase();
    return needle ? filterTree(children, needle) : children;
  }, [capture, filter]);
  const nodes = useMemo(() => toNodes(matched), [matched]);

  const selectedEl = capture && selectedRef ? findElement(capture.root, selectedRef) : null;

  const insert = () => {
    if (!selectedEl) return;
    const route = getCurrentRoute();
    const path = route.flowPath;
    if (!path) return;
    const buf = buffers[path];
    if (!buf) return;
    const snippet = commandFor(selectedEl, kind);
    const next = buf.content.endsWith("\n") || buf.content === ""
      ? `${buf.content}${snippet}\n`
      : `${buf.content}\n${snippet}\n`;
    setBufferContent(path, next);
  };

  return (
    <div className={styles.inspector}>
      <div className={styles.header}>
        <span className={styles.title}>Inspector</span>
        {screenCount > 0 ? (
          <button
            type="button"
            className={styles.graphButton}
            onClick={() => setGraphOpen(true)}
            title="Show the recorded screens and transitions"
          >
            <StatusPill tone="info">{screenCount} screens mapped</StatusPill>
          </button>
        ) : null}
        <div className={styles.spacer} />
        <Button
          size="sm"
          variant="secondary"
          icon="camera"
          disabled={!deviceId || loading}
          onClick={() => deviceId && void refreshCapture(deviceId)}
        >
          Capture UI
        </Button>
      </div>
      {capture ? (
        <div className={styles.filter}>
          <TextField
            className={styles.filterField}
            placeholder="Filter elements by id, text or role…"
            value={filter}
            icon="search"
            onChange={(e) => setFilter(e.target.value)}
          />
          {filter.trim() ? (
            <span className={styles.filterCount}>{countElements(matched)}</span>
          ) : null}
        </div>
      ) : null}
      <div className={styles.body}>
        {loading ? (
          <div className={styles.center}>
            <Spinner label="Capturing…" />
          </div>
        ) : error ? (
          <EmptyState icon="alert" title="Capture failed" description={error} />
        ) : !capture ? (
          <EmptyState
            icon="camera"
            title="No capture yet"
            description="Capture the UI to inspect the element hierarchy and generate commands."
          />
        ) : (
          nodes.length === 0 ? (
            <EmptyState
              icon="search"
              title="No elements match"
              description={`Nothing on screen matches “${filter}”.`}
            />
          ) : (
            <TreeView nodes={nodes} selectedId={selectedRef} onSelect={setSelectedRef} expandAll />
          )
        )}
      </div>
      {selectedEl ? (
        <div className={styles.snippet}>
          <Select
            options={[
              { value: "tapOn", label: "tapOn" },
              { value: "assertVisible", label: "assertVisible" },
              { value: "inputText", label: "inputText" },
              { value: "longPressOn", label: "longPressOn" },
              { value: "copyTextFrom", label: "copyTextFrom" },
            ]}
            value={kind}
            onChange={(e) => setKind(e.target.value as CommandKind)}
          />
          <pre className={styles.code}>{commandFor(selectedEl, kind)}</pre>
          <Button size="sm" variant="primary" icon="plus" onClick={insert}>
            Insert
          </Button>
        </div>
      ) : null}
      <SceneGraphDialog graph={graph} open={graphOpen} onClose={() => setGraphOpen(false)} />
    </div>
  );
}
