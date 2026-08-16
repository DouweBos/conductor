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
import { useEffect, useRef, useState } from "react";

import {
  createFlowFromTemplate,
  createFolder,
  deleteFlow,
  duplicateFlow,
  findUsages,
  listFlowTemplates,
  loadFlowCatalog,
  renameFlow,
  revealPath,
  searchFlows,
} from "../../lib/ipc";
import { aliasFor } from "../../lib/flowRefs";
import { selectFlow } from "../../lib/router";
import {
  FLOW_SEARCH_LIMIT,
  type FlowReference,
  type FlowSearchHit,
  type FlowTemplate,
} from "../../lib/types";
import { requestReveal } from "../../stores/flowStore";
import {
  refreshFlows,
  selectFlowsDir,
  useFlows,
  useProject,
  useProjectLoading,
} from "../../stores/projectStore";
import styles from "./FlowSidebar.module.css";

const DEFAULT_TEMPLATE = "blank";

type PromptKind = "new" | "rename" | "duplicate" | "newfolder" | "delete";
interface Prompt {
  kind: PromptKind;
  target?: string;
  value: string;
  isDir?: boolean;
  /** "new" only: which scaffold to use, and the answers to its `{{vars}}`. */
  templateId?: string;
  vars?: Record<string, string>;
}

type EntryKind = "file" | "dir";
interface MenuTarget {
  path: string;
  type: EntryKind;
  x: number;
  y: number;
}

function suggestDuplicate(path: string, isDir: boolean): string {
  const dot = path.lastIndexOf(".");
  return !isDir && dot > 0 ? `${path.slice(0, dot)}-copy${path.slice(dot)}` : `${path}-copy`;
}

/** Where a "new" action lands: inside a folder, or beside a file. */
function containingDir(path: string, type: EntryKind): string {
  if (type === "dir") return `${path}/`;
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : `${path.slice(0, cut + 1)}`;
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
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [templates, setTemplates] = useState<FlowTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Cmd/Ctrl+Shift+F searches every flow, the way Cmd+F searches the open one.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "f" || !event.shiftKey) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // config.yaml `paths:`, so the menu can offer the `@alias/…` form of a path.
  useEffect(() => {
    if (!project) {
      setAliases({});
      return;
    }
    void loadFlowCatalog()
      .then((catalog) => setAliases(catalog.aliases))
      .catch(() => setAliases({}));
  }, [project?.flowsDir]);

  useEffect(() => {
    void listFlowTemplates()
      .then(setTemplates)
      .catch(() => setTemplates([]));
  }, [project?.flowsDir]);

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

  // The scaffold the New-flow dialog is pointed at, and so which `{{vars}}` it asks for.
  const template =
    templates.find((t) => t.id === (prompt?.templateId ?? DEFAULT_TEMPLATE)) ?? templates[0];

  const commit = async () => {
    if (!prompt) return;
    const value = prompt.value.trim();
    try {
      if (prompt.kind === "new") {
        const path = /\.(ya?ml|js|ts)$/.test(value) ? value : `${value}.yaml`;
        await createFlowFromTemplate(template?.id ?? DEFAULT_TEMPLATE, path, prompt.vars ?? {});
        selectFlow(path);
      } else if (prompt.kind === "rename" && prompt.target) {
        const { updated } = await renameFlow(prompt.target, value);
        if (updated.length) {
          setNotice(`Repointed ${updated.length} file${updated.length === 1 ? "" : "s"} that called it.`);
        }
        // The open flow follows the rename, whether it moved itself or its folder did.
        if (activePath === prompt.target) selectFlow(value);
        else if (prompt.isDir && activePath?.startsWith(`${prompt.target}/`)) {
          selectFlow(value + activePath.slice(prompt.target.length));
        }
      } else if (prompt.kind === "duplicate" && prompt.target) {
        await duplicateFlow(prompt.target, value);
        if (!prompt.isDir) selectFlow(value);
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

  const copy = async (text: string, what: string) => {
    await navigator.clipboard.writeText(text);
    setNotice(`Copied ${what}: ${text}`);
  };

  const menuItems = ({ path, type }: MenuTarget): ContextMenuItem[] => {
    const isDir = type === "dir";
    const inside = containingDir(path, type);
    const aliased = aliasFor(path, aliases);
    const absolute = project ? `${project.flowsDir}/${path}` : path;
    return [
      {
        label: isDir ? "New flow here…" : "New flow…",
        icon: "plus",
        onClick: () => setPrompt({ kind: "new", value: inside }),
      },
      {
        label: isDir ? "New folder here…" : "New folder…",
        icon: "folder",
        onClick: () => setPrompt({ kind: "newfolder", value: inside }),
      },
      { separator: true },
      {
        label: "Rename…",
        icon: isDir ? "folder" : "file",
        onClick: () => setPrompt({ kind: "rename", target: path, value: path, isDir }),
      },
      {
        label: "Duplicate…",
        icon: "copy",
        onClick: () =>
          setPrompt({ kind: "duplicate", target: path, value: suggestDuplicate(path, isDir), isDir }),
      },
      ...(isDir
        ? []
        : [
            {
              label: "Find usages",
              icon: "search" as const,
              onClick: () => void findUsages(path).then((refs) => setUsages({ path, refs })),
            },
          ]),
      { separator: true },
      { label: "Copy relative path", icon: "copy", onClick: () => void copy(path, "path") },
      ...(aliased
        ? [
            {
              label: "Copy aliased path",
              icon: "copy" as const,
              onClick: () => void copy(aliased, "alias"),
            },
          ]
        : []),
      { label: "Copy absolute path", icon: "copy", onClick: () => void copy(absolute, "path") },
      { label: "Reveal in Finder", icon: "folderOpen", onClick: () => void revealPath(absolute) },
      { separator: true },
      {
        label: "Delete",
        icon: "trash",
        danger: true,
        onClick: () => setPrompt({ kind: "delete", target: path, value: path, isDir }),
      },
    ];
  };

  const promptTitle = (p: Prompt): string =>
    ({
      new: "New flow",
      rename: p.isDir ? "Rename folder" : "Rename",
      duplicate: p.isDir ? "Duplicate folder" : "Duplicate",
      newfolder: "New folder",
      delete: p.isDir ? "Delete folder" : "Delete flow",
    })[p.kind];

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
          ref={searchRef}
          placeholder="Search all flows… (⇧⌘F)"
          value={query}
          icon="search"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setQuery("")}
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
            <li className={styles.hitCount}>
              {hits.length >= FLOW_SEARCH_LIMIT
                ? `First ${FLOW_SEARCH_LIMIT} matches`
                : `${hits.length} match${hits.length === 1 ? "" : "es"}`}
            </li>
            {hits.map((hit) => (
              <li key={`${hit.path}:${hit.line}`}>
                <button
                  type="button"
                  className={styles.hit}
                  onClick={() => {
                    requestReveal(hit.path, hit.line);
                    selectFlow(hit.path);
                  }}
                >
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
          onContextMenu={(path, x, y, type) => setMenu({ path, x, y, type })}
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
        <ContextMenu open x={menu.x} y={menu.y} items={menuItems(menu)} onClose={() => setMenu(null)} />
      ) : null}

      <Dialog
        open={prompt !== null}
        title={prompt ? promptTitle(prompt) : ""}
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
            Delete <strong>{prompt.target}</strong>
            {prompt.isDir ? " and everything in it" : ""}? This cannot be undone.
          </p>
        ) : (
          <div className={styles.form}>
            <TextField
              label={prompt?.kind === "newfolder" ? "Folder path" : "Path"}
              placeholder={prompt?.kind === "newfolder" ? "auth" : "auth/login.yaml"}
              value={prompt?.value ?? ""}
              autoFocus
              onChange={(e) => setPrompt((p) => (p ? { ...p, value: e.target.value } : p))}
              onKeyDown={(e) => e.key === "Enter" && void commit()}
            />
            {prompt?.kind === "new" && templates.length ? (
              <>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>Template</span>
                  <Select
                    options={templates.map((t) => ({ value: t.id, label: t.label }))}
                    value={template?.id ?? ""}
                    onChange={(e) =>
                      setPrompt((p) => (p ? { ...p, templateId: e.target.value, vars: {} } : p))
                    }
                  />
                  {template?.description ? (
                    <span className={styles.fieldHint}>{template.description}</span>
                  ) : null}
                </div>
                {(template?.vars ?? []).map((name) => (
                  <TextField
                    key={name}
                    label={name}
                    value={prompt.vars?.[name] ?? ""}
                    onChange={(e) =>
                      setPrompt((p) =>
                        p ? { ...p, vars: { ...p.vars, [name]: e.target.value } } : p,
                      )
                    }
                    onKeyDown={(e) => e.key === "Enter" && void commit()}
                  />
                ))}
              </>
            ) : null}
          </div>
        )}
        {error ? <p style={{ color: "var(--error)", marginTop: 8 }}>{error}</p> : null}
      </Dialog>
    </Panel>
  );
}
