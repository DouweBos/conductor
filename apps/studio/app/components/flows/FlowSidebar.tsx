import {
  Button,
  ContextMenu,
  Dialog,
  EmptyState,
  FileTree,
  IconButton,
  Panel,
  Select,
  Spinner,
  TextField,
  type ContextMenuItem,
} from "@conductor/studio-ui";
import { useEffect, useState } from "react";

import {
  createFlow,
  createFolder,
  deleteFlow,
  duplicateFlow,
  findUsages,
  renameFlow,
  searchFlows,
} from "../../lib/ipc";
import { selectFlow } from "../../lib/router";
import type { FlowReference, FlowSearchHit } from "../../lib/types";
import {
  refreshFlows,
  selectFlowsDir,
  useFlows,
  useProject,
  useProjectLoading,
} from "../../stores/projectStore";
import styles from "./FlowSidebar.module.css";

const FLOW_TEMPLATE = `appId: com.example.app
---
- launchApp
`;

type PromptKind = "new" | "rename" | "duplicate" | "newfolder" | "delete";
interface Prompt {
  kind: PromptKind;
  target?: string;
  value: string;
}

function suggestDuplicate(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot > 0 ? `${path.slice(0, dot)}-copy${path.slice(dot)}` : `${path}-copy`;
}

export function FlowSidebar({ activePath }: { activePath?: string }) {
  const flows = useFlows();
  const project = useProject();
  const loading = useProjectLoading();
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<FlowSearchHit[]>([]);
  const [usages, setUsages] = useState<{ path: string; refs: FlowReference[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    const timer = setTimeout(() => {
      void searchFlows(query).then(setHits).catch(() => setHits([]));
    }, 150);
    return () => clearTimeout(timer);
  }, [query]);

  const commit = async () => {
    if (!prompt) return;
    const value = prompt.value.trim();
    try {
      if (prompt.kind === "new") {
        const path = /\.(ya?ml|js|ts)$/.test(value) ? value : `${value}.yaml`;
        await createFlow(path, FLOW_TEMPLATE);
        selectFlow(path);
      } else if (prompt.kind === "rename" && prompt.target) {
        const { updated } = await renameFlow(prompt.target, value);
        if (updated.length) {
          setNotice(`Repointed ${updated.length} file${updated.length === 1 ? "" : "s"} that called it.`);
        }
        if (activePath === prompt.target) selectFlow(value);
      } else if (prompt.kind === "duplicate" && prompt.target) {
        await duplicateFlow(prompt.target, value);
        selectFlow(value);
      } else if (prompt.kind === "newfolder") {
        await createFolder(value);
      } else if (prompt.kind === "delete" && prompt.target) {
        await deleteFlow(prompt.target);
      }
      await refreshFlows();
      setPrompt(null);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const menuItems = (path: string): ContextMenuItem[] => [
    { label: "Rename", icon: "file", onClick: () => setPrompt({ kind: "rename", target: path, value: path }) },
    {
      label: "Duplicate",
      icon: "plus",
      onClick: () => setPrompt({ kind: "duplicate", target: path, value: suggestDuplicate(path) }),
    },
    {
      label: "Find usages",
      icon: "search",
      onClick: () => void findUsages(path).then((refs) => setUsages({ path, refs })),
    },
    { label: "New folder", icon: "folder", onClick: () => setPrompt({ kind: "newfolder", value: "" }) },
    { label: "Delete", icon: "close", danger: true, onClick: () => setPrompt({ kind: "delete", target: path, value: path }) },
  ];

  const promptTitle: Record<PromptKind, string> = {
    new: "New flow",
    rename: "Rename",
    duplicate: "Duplicate",
    newfolder: "New folder",
    delete: "Delete flow",
  };

  // Monorepos have more than one; name the one we're showing either way.
  const dirs = project?.flowsDirs ?? [];
  const relative = (dir: string) =>
    project ? dir.slice(project.root.length + 1) || "." : dir;

  return (
    <Panel
      title="Flows"
      flush
      actions={
        <>
          <IconButton icon="plus" label="New flow" onClick={() => setPrompt({ kind: "new", value: "" })} />
          <IconButton icon="refresh" label="Refresh" onClick={() => void refreshFlows()} />
        </>
      }
    >
      {project ? (
        dirs.length > 1 ? (
          <div className={styles.dirBar}>
            <Select
              options={dirs.map((dir) => ({ value: dir, label: relative(dir) }))}
              value={project.flowsDir}
              onChange={(e) => void selectFlowsDir(e.target.value)}
              className={styles.dirSelect}
            />
          </div>
        ) : (
          <div className={styles.dirBar} title={project.flowsDir}>
            <span className={styles.dirPath}>{relative(project.flowsDir)}</span>
          </div>
        )
      ) : null}
      <div className={styles.searchBar}>
        <TextField
          placeholder="Search flows…"
          value={query}
          icon="search"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {notice ? (
        <button type="button" className={styles.notice} onClick={() => setNotice(null)}>
          {notice}
        </button>
      ) : null}
      {query.trim() ? (
        hits.length === 0 ? (
          <EmptyState icon="search" title="No matches" description={`Nothing matches “${query}”.`} />
        ) : (
          <ul className={styles.hits}>
            {hits.map((hit) => (
              <li key={`${hit.path}:${hit.line}`}>
                <button type="button" className={styles.hit} onClick={() => selectFlow(hit.path)}>
                  <span className={styles.hitPath}>
                    {hit.path}:{hit.line}
                  </span>
                  <span className={styles.hitText}>{hit.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : loading ? (
        <div style={{ padding: 12 }}>
          <Spinner label="Loading flows…" />
        </div>
      ) : flows.length === 0 ? (
        <EmptyState
          icon="flow"
          title="No flows yet"
          description={project ? "Create a flow to get started." : "Open a project to see its flows."}
          action={
            <Button variant="primary" icon="plus" onClick={() => setPrompt({ kind: "new", value: "" })}>
              New flow
            </Button>
          }
        />
      ) : (
        <FileTree
          entries={flows}
          selectedPath={activePath}
          onSelectFile={selectFlow}
          onContextMenu={(path, x, y) => setMenu({ path, x, y })}
        />
      )}

      <Dialog
        open={usages !== null}
        title={usages ? `Usages of ${usages.path}` : ""}
        onClose={() => setUsages(null)}
      >
        {usages && usages.refs.length === 0 ? (
          <p className={styles.empty}>Nothing calls this flow.</p>
        ) : (
          <ul className={styles.hits}>
            {(usages?.refs ?? []).map((ref) => (
              <li key={`${ref.from}:${ref.line}`}>
                <button
                  type="button"
                  className={styles.hit}
                  onClick={() => {
                    selectFlow(ref.from);
                    setUsages(null);
                  }}
                >
                  <span className={styles.hitPath}>
                    {ref.from}:{ref.line}
                  </span>
                  <span className={styles.hitText}>{ref.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Dialog>

      {menu ? (
        <ContextMenu open x={menu.x} y={menu.y} items={menuItems(menu.path)} onClose={() => setMenu(null)} />
      ) : null}

      <Dialog
        open={prompt !== null}
        title={prompt ? promptTitle[prompt.kind] : ""}
        onClose={() => {
          setPrompt(null);
          setError(null);
        }}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPrompt(null)}>
              Cancel
            </Button>
            <Button variant={prompt?.kind === "delete" ? "danger" : "primary"} onClick={() => void commit()}>
              {prompt?.kind === "delete" ? "Delete" : "OK"}
            </Button>
          </>
        }
      >
        {prompt?.kind === "delete" ? (
          <p>
            Delete <strong>{prompt.target}</strong>? This cannot be undone.
          </p>
        ) : (
          <TextField
            label={prompt?.kind === "newfolder" ? "Folder path" : "Path"}
            placeholder={prompt?.kind === "newfolder" ? "auth" : "auth/login.yaml"}
            value={prompt?.value ?? ""}
            autoFocus
            onChange={(e) => setPrompt((p) => (p ? { ...p, value: e.target.value } : p))}
            onKeyDown={(e) => e.key === "Enter" && void commit()}
          />
        )}
        {error ? <p style={{ color: "var(--error)", marginTop: 8 }}>{error}</p> : null}
      </Dialog>
    </Panel>
  );
}
