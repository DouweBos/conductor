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
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useIpcEvent } from "../../hooks/useIpcEvent";
import { loadSceneGraph } from "../../lib/ipc";
import { getCurrentRoute } from "../../lib/router";
import type { CaptureElement, CaptureUiResult, SceneGraph } from "../../lib/types";
import { setBufferContent, useFlowBuffers } from "../../stores/flowStore";
import {
  findElement,
  isInView,
  refreshCapture,
  setHoveredRef,
  setSelectedRef,
  useCapture,
  useCaptureError,
  useCaptureLoading,
  useSelectedRef,
} from "../../stores/inspectStore";
import { SceneGraphDialog } from "./SceneGraphDialog";
import styles from "./Inspector.module.css";

/** Text a search matches against: id, label, role, and the `@eN` ref if it has one. */
function haystack(el: CaptureElement): string {
  // A synthetic ref is a node path like `#0.1.2` — searching digits shouldn't hit it.
  const ref = el.a11y ? el.ref : undefined;
  return [el.identifier, el.text, el.role, ref].filter(Boolean).join(" ").toLowerCase();
}

/**
 * Just the matching elements — the ancestors leading to each hit are noise when
 * you already know what you're after. A hit inside another hit keeps its
 * nesting, though: only the non-matching nodes between them are dropped.
 */
function matchesFor(elements: CaptureElement[], needle: string): CaptureElement[] {
  const out: CaptureElement[] = [];
  for (const el of elements) {
    const children = matchesFor(el.children ?? [], needle);
    if (haystack(el).includes(needle)) out.push({ ...el, children });
    else out.push(...children);
  }
  return out;
}

function countElements(elements: CaptureElement[]): number {
  return elements.reduce((sum, el) => sum + 1 + countElements(el.children ?? []), 0);
}

/**
 * The identifier leads: it's what selectors should target, and a row showing
 * only a role read as an anonymous "Element" even when it had one.
 */
function labelFor(el: CaptureElement): string {
  const name = el.identifier ? `#${el.identifier}` : el.text ? `“${el.text}”` : "";
  // What's left with no name is a grouping wrapper we kept because it branches.
  const role = el.role || (name ? "Element" : "Group");
  return name ? `${role} ${name}` : role;
}

/**
 * Trailing badges: size, whether it's on screen, and the `@eN` ref if it has
 * one. Size is what tells two rows apart when they carry the same label — a
 * container and the text inside it are otherwise identical rows.
 */
function metaFor(el: CaptureElement, screen: CaptureUiResult): ReactNode {
  const size = el.bounds ? `${Math.round(el.bounds.width)}×${Math.round(el.bounds.height)}` : null;
  const inView = isInView(el, screen);
  const ref = el.a11y ? el.ref : null;
  if (!size && !inView && !ref) return undefined;
  return (
    <>
      {size ? <span className={styles.size}>{size}</span> : null}
      {inView ? <span className={styles.inView}>in view</span> : null}
      {ref}
    </>
  );
}

function toNodes(elements: CaptureElement[], screen: CaptureUiResult): TreeNode[] {
  return elements.map((el, i) => ({
    id: el.ref || `el-${i}`,
    label: labelFor(el),
    icon: "dot",
    meta: metaFor(el, screen),
    children: el.children?.length ? toNodes(el.children, screen) : undefined,
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

  // The panel can swap out mid-hover (picking a row shows the commands), and a
  // row that unmounts never fires mouseleave — the highlight would stick.
  useEffect(() => () => setHoveredRef(null), []);
  useIpcEvent<SceneGraph>("scenegraph:updated", setGraph);

  const screenCount = graph?.nodes.length ?? 0;

  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const matches = useMemo(
    () => (needle ? matchesFor(capture?.root.children ?? [], needle) : null),
    [capture, needle],
  );
  const nodes = useMemo(() => {
    if (!capture) return [];
    return toNodes(matches ?? capture.root.children ?? [], capture);
  }, [matches, capture]);

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
          {matches ? <span className={styles.filterCount}>{countElements(matches)}</span> : null}
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
            <TreeView
              nodes={nodes}
              selectedId={selectedRef}
              onSelect={setSelectedRef}
              onHover={setHoveredRef}
              expandAll
            />
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
