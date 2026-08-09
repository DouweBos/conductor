import {
  Button,
  ContextMenu,
  Dialog,
  Editor,
  EmptyState,
  IconButton,
  Spinner,
  StatusPill,
  Tabs,
  TextField,
  Toolbar,
  ToolbarDivider,
  ToolbarSpacer,
  type EditorApi,
  type TabItem,
} from "@conductor/studio-ui";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  getMaestroStatus,
  listEnvNames,
  loadFlowCatalog,
  runFlow,
  runFlowInline,
  runFolder,
} from "../../lib/ipc";
import { referenceOnLine, resolveReference } from "../../lib/flowRefs";
import { flowForSteps, parseSteps, stepAt, stepsUntil } from "../../lib/flowSteps";
import { maestroCompletion } from "../../lib/maestroCompletion";
import { selectFlow } from "../../lib/router";
import type { FlowCatalog, MaestroStatus, RunOptions } from "../../lib/types";
import { useSelectedDeviceId } from "../../stores/deviceStore";
import {
  closeFile,
  languageFor,
  saveFile,
  setBufferContent,
  useBuffer,
  useFlowBuffers,
  useOpenTabs,
} from "../../stores/flowStore";
import { beginRun } from "../../stores/runStore";
import { useResolvedTheme } from "../../stores/themeStore";
import { RunConsole } from "./RunConsole";
import styles from "./EditorPane.module.css";

interface EnvRow {
  key: string;
  value: string;
}

function extractAppId(content: string | undefined): string | undefined {
  return content?.match(/^appId:\s*(.+)$/m)?.[1]?.trim();
}

export function EditorPane({ activePath }: { activePath?: string }) {
  const openTabs = useOpenTabs();
  const buffers = useFlowBuffers();
  const buffer = useBuffer(activePath);
  const theme = useResolvedTheme();
  const deviceId = useSelectedDeviceId();
  const [status, setStatus] = useState<MaestroStatus | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
  const [includeTags, setIncludeTags] = useState("");
  const [excludeTags, setExcludeTags] = useState("");
  const editorApi = useRef<EditorApi | null>(null);
  const [stepMenu, setStepMenu] = useState<{ line: number; x: number; y: number } | null>(null);
  // The project's env vocabulary, read through a ref so the completion source
  // stays stable while the names refresh underneath it.
  const envNames = useRef<string[]>([]);
  const catalog = useRef<FlowCatalog>({ entries: [], aliases: {} });
  const currentPath = useRef<string | undefined>(activePath);
  currentPath.current = activePath;
  const completions = useMemo(
    () =>
      maestroCompletion({
        envNames: () => envNames.current,
        catalog: () => catalog.current,
        currentPath: () => currentPath.current,
      }),
    [],
  );

  useEffect(() => {
    listEnvNames()
      .then((names) => (envNames.current = names))
      .catch(() => {});
    loadFlowCatalog()
      .then((loaded) => (catalog.current = loaded))
      .catch(() => {});
  }, [activePath]);

  useEffect(() => {
    getMaestroStatus().then(setStatus).catch(() => {});
  }, []);

  const tabs: TabItem[] = openTabs.map((path) => ({
    id: path,
    label: path.split("/").slice(-1)[0],
    icon: languageFor(path) === "javascript" ? "code" : "file",
    dirty: buffers[path]?.dirty ?? false,
  }));

  const options = (): RunOptions => {
    const env: Record<string, string> = {};
    for (const row of envRows) if (row.key.trim()) env[row.key.trim()] = row.value;
    return {
      env: Object.keys(env).length ? env : undefined,
      includeTags: includeTags.trim() || undefined,
      excludeTags: excludeTags.trim() || undefined,
    };
  };

  const run = async () => {
    if (!activePath) return;
    try {
      const { runId } = await runFlow(activePath, deviceId ?? undefined, options());
      beginRun(runId, activePath);
    } catch {
      /* surfaced in console */
    }
  };

  const runSelection = async () => {
    const snippet = editorApi.current?.getSelection() ?? "";
    if (!snippet.trim()) return;
    try {
      const { runId } = await runFlowInline(
        snippet,
        deviceId ?? undefined,
        extractAppId(buffer?.content),
        options(),
      );
      beginRun(runId, `${activePath ?? "selection"} (selection)`);
    } catch {
      /* surfaced in console */
    }
  };

  // Run controls in the gutter: one step, or everything up to and including it.
  const steps = useMemo(() => parseSteps(buffer?.content ?? ""), [buffer?.content]);

  const runSteps = async (chosen: ReturnType<typeof parseSteps>, label: string) => {
    const content = buffer?.content;
    if (!content || chosen.length === 0) return;
    try {
      const { runId } = await runFlowInline(
        flowForSteps(content, chosen),
        deviceId ?? undefined,
        undefined,
        options(),
      );
      beginRun(runId, `${activePath ?? "flow"} (${label})`);
    } catch {
      /* surfaced in console */
    }
  };

  const runGutter = useMemo(
    () => ({
      lines: steps.map((step) => step.line),
      onRun: (line: number) => {
        const step = stepAt(steps, line);
        if (step) void runSteps([step], `step ${steps.indexOf(step) + 1}`);
      },
      onMenu: (line: number, x: number, y: number) => setStepMenu({ line, x, y }),
      runLabel: "Run this step",
      menuLabel: "More run options",
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [steps],
  );

  // Cmd-click a `runFlow: …` line to open the subflow it names.
  const followLine = (lineText: string) => {
    const raw = referenceOnLine(lineText);
    if (!raw) return;
    const target = resolveReference(raw, activePath ?? "", catalog.current.aliases);
    if (target && catalog.current.entries.some((e) => e.path === target)) selectFlow(target);
  };

  const runAll = async () => {
    try {
      const { runId } = await runFolder(undefined, deviceId ?? undefined, options());
      beginRun(runId, "all flows");
    } catch {
      /* surfaced in console */
    }
  };

  if (openTabs.length === 0 || !activePath) {
    return (
      <div className={styles.pane}>
        <Toolbar>
          <Button variant="secondary" size="sm" icon="play" onClick={() => void runAll()} disabled={!status}>
            Run all
          </Button>
          <ToolbarSpacer />
          {status ? (
            <StatusPill tone={status.activeEngine === "maestro" ? "info" : "running"}>
              engine: {status.activeEngine}
            </StatusPill>
          ) : null}
        </Toolbar>
        <div className={styles.editor}>
          <EmptyState
            icon="code"
            title="No flow open"
            description="Select a flow from the sidebar to edit it, or run all flows."
          />
        </div>
        <div className={styles.console}>
          <RunConsole />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.pane}>
      <Tabs tabs={tabs} activeId={activePath} onSelect={selectFlow} onClose={closeFile} />
      <Toolbar>
        <Button variant="primary" size="sm" icon="play" onClick={() => void run()}>
          Run
        </Button>
        <Button variant="secondary" size="sm" icon="code" onClick={() => void runSelection()}>
          Run selection
        </Button>
        <Button variant="ghost" size="sm" icon="flow" onClick={() => void runAll()}>
          Run all
        </Button>
        <IconButton icon="settings" label="Run options" onClick={() => setOptionsOpen(true)} />
        <ToolbarDivider />
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
            completions={languageFor(activePath) === "yaml" ? completions : undefined}
            runGutter={languageFor(activePath) === "yaml" ? runGutter : undefined}
            onFollowLine={followLine}
            registerApi={(api) => (editorApi.current = api)}
            onChange={(v) => setBufferContent(activePath, v)}
            onSave={() => void saveFile(activePath)}
          />
        )}
      </div>
      <div className={styles.console}>
        <RunConsole />
      </div>

      {stepMenu ? (
        <ContextMenu
          open
          x={stepMenu.x}
          y={stepMenu.y}
          items={[
            {
              label: "Run all until here",
              icon: "play",
              onClick: () => {
                const chosen = stepsUntil(steps, stepMenu.line);
                void runSteps(chosen, `through step ${chosen.length}`);
              },
            },
          ]}
          onClose={() => setStepMenu(null)}
        />
      ) : null}

      <Dialog
        open={optionsOpen}
        title="Run options"
        onClose={() => setOptionsOpen(false)}
        footer={
          <Button variant="primary" onClick={() => setOptionsOpen(false)}>
            Done
          </Button>
        }
      >
        <div className={styles.optionsSection}>
          <div className={styles.optionsLabel}>Environment variables</div>
          {envRows.map((row, i) => (
            <div key={i} className={styles.envRow}>
              <TextField
                placeholder="KEY"
                value={row.key}
                onChange={(e) =>
                  setEnvRows((rows) => rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))
                }
              />
              <TextField
                placeholder="value"
                value={row.value}
                onChange={(e) =>
                  setEnvRows((rows) => rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
                }
              />
              <IconButton
                icon="close"
                label="Remove"
                onClick={() => setEnvRows((rows) => rows.filter((_, j) => j !== i))}
              />
            </div>
          ))}
          <Button
            size="sm"
            variant="ghost"
            icon="plus"
            onClick={() => setEnvRows((rows) => [...rows, { key: "", value: "" }])}
          >
            Add variable
          </Button>
        </div>
        <div className={styles.optionsSection}>
          <TextField
            label="Include tags (comma-separated, maestro only)"
            placeholder="smoke, checkout"
            value={includeTags}
            onChange={(e) => setIncludeTags(e.target.value)}
          />
        </div>
        <div className={styles.optionsSection}>
          <TextField
            label="Exclude tags (maestro only)"
            placeholder="flaky"
            value={excludeTags}
            onChange={(e) => setExcludeTags(e.target.value)}
          />
        </div>
      </Dialog>
    </div>
  );
}
