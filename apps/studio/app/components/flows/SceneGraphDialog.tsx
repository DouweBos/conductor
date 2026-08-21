import { Dialog, EmptyState } from "@conductor/studio-ui";

import type { SceneGraph } from "../../lib/types";
import styles from "./SceneGraphDialog.module.css";

/** The recorded screens and the actions that move between them. */
export function SceneGraphDialog({
  graph,
  open,
  onClose,
}: {
  graph: SceneGraph | null;
  open: boolean;
  onClose: () => void;
}) {
  const nodes = graph?.nodes ?? [];
  const labelOf = (id: string) => nodes.find((n) => n.id === id)?.label ?? id;

  return (
    <Dialog
      open={open}
      title={graph?.app ? `Scene graph — ${graph.app.appName}` : "Scene graph"}
      onClose={onClose}
      width={560}
    >
      {graph?.app ? (
        <p className={styles.app}>
          {graph.app.appId} · {graph.app.platform}
        </p>
      ) : null}
      {nodes.length === 0 ? (
        <EmptyState
          icon="flow"
          title="No screens recorded"
          description="Capture the UI, act on the device, then capture again — each capture becomes a screen and each action an edge."
        />
      ) : (
        <ul className={styles.screens}>
          {nodes.map((node) => {
            const out = (graph?.edges ?? []).filter((e) => e.from === node.id);
            return (
              <li key={node.id} className={styles.screen}>
                <div className={styles.name}>{node.label}</div>
                <div className={styles.id}>{node.id}</div>
                {out.length ? (
                  <ul className={styles.edges}>
                    {out.map((edge, i) => (
                      <li key={i} className={styles.edge}>
                        <code>{edge.action}</code> → {labelOf(edge.to)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className={styles.noEdges}>no recorded transitions</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className={styles.path}>
        Stored in ~/.conductor/studio/scenegraphs/{graph?.app?.key ?? "<app>"}.json
      </p>
    </Dialog>
  );
}
