import {
  Button,
  EmptyState,
  Spinner,
  TreeView,
  type TreeNode,
} from "@conductor/studio-ui";
import { useMemo, useState } from "react";

import { captureUi } from "../../lib/ipc";
import { getCurrentRoute } from "../../lib/router";
import type { CaptureElement, CaptureUiResult } from "../../lib/types";
import { setBufferContent, useFlowBuffers } from "../../stores/flowStore";
import styles from "./Inspector.module.css";

function toNodes(elements: CaptureElement[]): TreeNode[] {
  return elements.map((el, i) => ({
    id: el.ref || `el-${i}`,
    label: el.text ? `${el.role ?? "Element"} “${el.text}”` : el.role || "Element",
    icon: "dot",
    meta: el.ref,
    children: el.children && el.children.length ? toNodes(el.children) : undefined,
  }));
}

function findElement(root: CaptureElement, ref: string): CaptureElement | null {
  if (root.ref === ref) return root;
  for (const child of root.children ?? []) {
    const found = findElement(child, ref);
    if (found) return found;
  }
  return null;
}

/** Maestro command suggested for the selected element (Studio's signature feature). */
export function commandFor(el: CaptureElement): string {
  if (el.text) return `- tapOn: "${el.text}"`;
  if (el.identifier) return `- tapOn:\n    id: "${el.identifier}"`;
  if (el.bounds) {
    return `- tapOn:\n    point: "${Math.round(el.bounds.x + el.bounds.width / 2)},${Math.round(
      el.bounds.y + el.bounds.height / 2,
    )}"`;
  }
  return `- tapOn: "${el.ref}"`;
}

export function Inspector({ deviceId }: { deviceId: string | null }) {
  const [capture, setCapture] = useState<CaptureUiResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const buffers = useFlowBuffers();

  const nodes = useMemo(
    () => (capture ? toNodes(capture.root.children ?? []) : []),
    [capture],
  );

  const selectedEl = capture && selectedRef ? findElement(capture.root, selectedRef) : null;

  const capture_ = async () => {
    if (!deviceId) return;
    setLoading(true);
    setError(null);
    try {
      setCapture(await captureUi(deviceId));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const insert = () => {
    if (!selectedEl) return;
    const route = getCurrentRoute();
    const path = route.flowPath;
    if (!path) return;
    const buf = buffers[path];
    if (!buf) return;
    const snippet = commandFor(selectedEl);
    const next = buf.content.endsWith("\n") || buf.content === ""
      ? `${buf.content}${snippet}\n`
      : `${buf.content}\n${snippet}\n`;
    setBufferContent(path, next);
  };

  return (
    <div className={styles.inspector}>
      <div className={styles.header}>
        <span className={styles.title}>Inspector</span>
        <div className={styles.spacer} />
        <Button
          size="sm"
          variant="secondary"
          icon="search"
          disabled={!deviceId || loading}
          onClick={() => void capture_()}
        >
          Capture UI
        </Button>
      </div>
      <div className={styles.body}>
        {loading ? (
          <div className={styles.center}>
            <Spinner label="Capturing…" />
          </div>
        ) : error ? (
          <EmptyState icon="alert" title="Capture failed" description={error} />
        ) : !capture ? (
          <EmptyState
            icon="search"
            title="No capture yet"
            description="Capture the UI to inspect the element hierarchy and generate commands."
          />
        ) : (
          <TreeView nodes={nodes} selectedId={selectedRef} onSelect={setSelectedRef} expandAll />
        )}
      </div>
      {selectedEl ? (
        <div className={styles.snippet}>
          <pre className={styles.code}>{commandFor(selectedEl)}</pre>
          <Button size="sm" variant="primary" icon="plus" onClick={insert}>
            Insert
          </Button>
        </div>
      ) : null}
    </div>
  );
}
