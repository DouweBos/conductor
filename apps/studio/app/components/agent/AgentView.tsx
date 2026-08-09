import { Button, Icon, Panel, StatusPill, Tag } from "@conductor/studio-ui";
import { useEffect, useState } from "react";

import { agentStatus, listPoms, loadSceneGraph } from "../../lib/ipc";
import type { PomEntry, SceneGraph } from "../../lib/types";
import styles from "./AgentView.module.css";

export function AgentView() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [poms, setPoms] = useState<PomEntry[]>([]);
  const [graph, setGraph] = useState<SceneGraph | null>(null);

  useEffect(() => {
    agentStatus().then((s) => setAvailable(s.available)).catch(() => setAvailable(false));
    listPoms().then(setPoms).catch(() => {});
    loadSceneGraph().then(setGraph).catch(() => {});
  }, []);

  return (
    <div className={styles.view}>
      <div className={styles.hero}>
        <div className={styles.heroIcon}>
          <Icon name="agent" size={28} />
        </div>
        <div>
          <h1 className={styles.title}>Agentic test writing</h1>
          <p className={styles.subtitle}>
            A Claude Code agent drives the app through conductor, reuses your Maestro
            subflow POMs, and builds a scene graph so later runs skip re-orientation.
          </p>
        </div>
        <div className={styles.status}>
          {available === null ? null : available ? (
            <StatusPill tone="success">Claude Code detected</StatusPill>
          ) : (
            <StatusPill tone="warning">Claude Code not on PATH</StatusPill>
          )}
        </div>
      </div>

      <div className={styles.grid}>
        <Panel title="Reusable POMs (Maestro subflows)">
          {poms.length === 0 ? (
            <p className={styles.muted}>
              No parameterized subflows found. Subflows with an <code>env:</code> block become
              POMs the agent composes via <code>runFlow</code>.
            </p>
          ) : (
            <ul className={styles.pomList}>
              {poms.map((pom) => (
                <li key={pom.path} className={styles.pomItem}>
                  <div className={styles.pomName}>
                    <Icon name="flow" size={14} />
                    {pom.name}
                  </div>
                  <div className={styles.pomTags}>
                    {pom.params.map((p) => (
                      <Tag key={p}>{p}</Tag>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Scene graph">
          <div className={styles.graphStat}>
            <div className={styles.stat}>
              <span className={styles.statValue}>{graph?.nodes.length ?? 0}</span>
              <span className={styles.statLabel}>screens</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statValue}>{graph?.edges.length ?? 0}</span>
              <span className={styles.statLabel}>transitions</span>
            </div>
          </div>
          <p className={styles.muted}>
            Discovered screens are stored in <code>.conductor-studio/scenegraph.json</code>{" "}
            and seed subsequent agent runs.
          </p>
        </Panel>
      </div>

      <div className={styles.cta}>
        <Button variant="primary" icon="agent" disabled>
          Start agentic run
        </Button>
        <span className={styles.ctaNote}>
          The live agent runner lands in a follow-up — the data layer (POM catalog, scene
          graph, conductor control) is wired and ready.
        </span>
      </div>
    </div>
  );
}
