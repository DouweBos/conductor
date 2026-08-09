import {
  Button,
  Dialog,
  EmptyState,
  FileTree,
  IconButton,
  Panel,
  Spinner,
  TextField,
} from "@conductor/studio-ui";
import { useState } from "react";

import { createFlow } from "../../lib/ipc";
import { selectFlow } from "../../lib/router";
import {
  refreshFlows,
  useFlows,
  useProject,
  useProjectLoading,
} from "../../stores/projectStore";

const FLOW_TEMPLATE = `appId: com.example.app
---
- launchApp
`;

export function FlowSidebar({ activePath }: { activePath?: string }) {
  const flows = useFlows();
  const project = useProject();
  const loading = useProjectLoading();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const path = /\.(ya?ml|js|ts)$/.test(trimmed) ? trimmed : `${trimmed}.yaml`;
    try {
      await createFlow(path, FLOW_TEMPLATE);
      await refreshFlows();
      selectFlow(path);
      setDialogOpen(false);
      setName("");
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <Panel
      title="Flows"
      flush
      actions={
        <>
          <IconButton icon="plus" label="New flow" onClick={() => setDialogOpen(true)} />
          <IconButton icon="refresh" label="Refresh" onClick={() => void refreshFlows()} />
        </>
      }
    >
      {loading ? (
        <div style={{ padding: 12 }}>
          <Spinner label="Loading flows…" />
        </div>
      ) : flows.length === 0 ? (
        <EmptyState
          icon="flow"
          title="No flows yet"
          description={
            project
              ? `Create a flow in ${project.flowsDir.split("/").slice(-1)[0]}/.`
              : "Open a project to see its flows."
          }
          action={
            <Button variant="primary" icon="plus" onClick={() => setDialogOpen(true)}>
              New flow
            </Button>
          }
        />
      ) : (
        <FileTree entries={flows} selectedPath={activePath} onSelectFile={selectFlow} />
      )}

      <Dialog
        open={dialogOpen}
        title="New flow"
        onClose={() => setDialogOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void create()}>
              Create
            </Button>
          </>
        }
      >
        <TextField
          label="File name"
          placeholder="auth/login.yaml"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void create()}
        />
        {error ? <p style={{ color: "var(--error)", marginTop: 8 }}>{error}</p> : null}
      </Dialog>
    </Panel>
  );
}
