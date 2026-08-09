import {
  Button,
  EmptyState,
  Spinner,
  StatusPill,
  Tabs,
  Toolbar,
  ToolbarSpacer,
  Editor,
  type TabItem,
} from "@conductor/studio-ui";
import { useEffect, useState } from "react";

import { getMaestroStatus, runFlow } from "../../lib/ipc";
import { selectFlow } from "../../lib/router";
import type { MaestroStatus } from "../../lib/types";
import {
  closeFile,
  languageFor,
  saveFile,
  setBufferContent,
  useBuffer,
  useFlowBuffers,
  useOpenTabs,
} from "../../stores/flowStore";
import { useSelectedDeviceId } from "../../stores/deviceStore";
import { useResolvedTheme } from "../../stores/themeStore";
import { beginRun } from "../../stores/runStore";
import { RunConsole } from "./RunConsole";
import styles from "./EditorPane.module.css";

export function EditorPane({ activePath }: { activePath?: string }) {
  const openTabs = useOpenTabs();
  const buffers = useFlowBuffers();
  const buffer = useBuffer(activePath);
  const theme = useResolvedTheme();
  const deviceId = useSelectedDeviceId();
  const [status, setStatus] = useState<MaestroStatus | null>(null);

  useEffect(() => {
    getMaestroStatus().then(setStatus).catch(() => {});
  }, []);

  const tabs: TabItem[] = openTabs.map((path) => ({
    id: path,
    label: path.split("/").slice(-1)[0],
    icon: languageFor(path) === "javascript" ? "code" : "file",
    dirty: buffers[path]?.dirty ?? false,
  }));

  const run = async () => {
    if (!activePath) return;
    try {
      const { runId } = await runFlow(activePath, deviceId ?? undefined);
      beginRun(runId, activePath);
    } catch {
      // errors surface in the console via status; ignore here
    }
  };

  if (openTabs.length === 0 || !activePath) {
    return (
      <div className={styles.pane}>
        <EmptyState
          icon="code"
          title="No flow open"
          description="Select a flow from the sidebar to edit it, or create a new one."
        />
      </div>
    );
  }

  return (
    <div className={styles.pane}>
      <Tabs tabs={tabs} activeId={activePath} onSelect={selectFlow} onClose={closeFile} />
      <Toolbar>
        <Button
          variant="primary"
          size="sm"
          icon="play"
          disabled={!activePath}
          onClick={() => void run()}
        >
          Run
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!buffer?.dirty}
          onClick={() => activePath && void saveFile(activePath)}
        >
          Save
        </Button>
        <ToolbarSpacer />
        {status ? (
          <StatusPill tone={status.activeEngine === "maestro" ? "info" : "running"}>
            engine: {status.activeEngine}
          </StatusPill>
        ) : null}
      </Toolbar>
      <div className={styles.editor}>
        {buffer?.loading ? (
          <div className={styles.loading}>
            <Spinner label="Opening…" />
          </div>
        ) : (
          <Editor
            value={buffer?.content ?? ""}
            language={languageFor(activePath)}
            theme={theme}
            onChange={(v) => setBufferContent(activePath, v)}
            onSave={() => void saveFile(activePath)}
          />
        )}
      </div>
      <div className={styles.console}>
        <RunConsole />
      </div>
    </div>
  );
}
