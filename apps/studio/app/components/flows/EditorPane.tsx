import {
  Button,
  ContextMenu,
  Editor,
  EmptyState,
  IconButton,
  SplitPane,
  Spinner,
  StatusPill,
  Tabs,
  Toolbar,
  ToolbarDivider,
  ToolbarSpacer,
  type EditorApi,
  type TabItem,
} from "@conductor/studio-ui";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  changedFlows,
  getMaestroStatus,
  lintFlowContent,
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
import type { FlowCatalog, LintProblem, MaestroStatus } from "../../lib/types";
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
import {
  getRunOptions,
  openRunOptions,
  useActiveProfile,
  useHasRunOptions,
} from "../../stores/runOptionsStore";
import { beginRun } from "../../stores/runStore";
import { useResolvedTheme } from "../../stores/themeStore";
import { RunConsole } from "./RunConsole";
import styles from "./EditorPane.module.css";

function extractAppId(content: string | undefined): string | undefined {
  return content?.match(/^appId:\s*(.+)$/m)?.[1]?.trim();
}

export function EditorPane({ activePath }: { activePath?: string }) {
  const openTabs = useOpenTabs();
  const buffers = useFlowBuffers();
  const buffer = useBuffer(activePath);
  const theme = useResolvedTheme();
  const deviceId = useSelectedDeviceId();
  const hasRunOptions = useHasRunOptions();
  const activeProfile = useActiveProfile();
  const [status, setStatus] = useState<MaestroStatus | null>(null);
  const editorApi = useRef<EditorApi | null>(null);
  const [stepMenu, setStepMenu] = useState<{ line: number; x: number; y: number } | null>(null);
  const [problems, setProblems] = useState<LintProblem[]>([]);
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

  const run = async () => {
    if (!activePath) return;
    try {
      const { runId } = await runFlow(activePath, deviceId ?? undefined, getRunOptions());
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
        getRunOptions(),
      );
      beginRun(runId, `${activePath ?? "selection"} (selection)`);
    } catch {
      /* surfaced in console */
    }
  };

  // Everything I touched since main — the set worth running before pushing.
  const runChanged = async () => {
    const changed = await changedFlows();
    if (changed.length === 0) return;
    for (const flow of changed) {
      const { runId } = await runFlow(flow, deviceId ?? undefined, getRunOptions());
      beginRun(runId, flow);
    }
  };

  // Lint the buffer as it settles, so mistakes surface before a run does.
  useEffect(() => {
    if (!activePath || buffer?.content === undefined) return;
    const content = buffer.content;
    const timer = setTimeout(() => {
      lintFlowContent(activePath, content)
        .then(setProblems)
        .catch(() => setProblems([]));
    }, 400);
    return () => clearTimeout(timer);
  }, [activePath, buffer?.content]);

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
        getRunOptions(),
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
      rangeFor: (line: number, kind: "run" | "until") => {
        const step = stepAt(steps, line);
        if (!step) return { from: line, to: line };
        // The play button runs this step; the menu runs everything up to it.
        return { from: kind === "until" ? (steps[0]?.line ?? step.line) : step.line, to: step.endLine };
      },
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
      const { runId } = await runFolder(undefined, deviceId ?? undefined, getRunOptions());
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
          <Button variant="ghost" size="sm" icon="flow" onClick={() => void runChanged()} disabled={!status}>
            Run changed
          </Button>
          <IconButton
            icon="settings"
            active={hasRunOptions}
            label={hasRunOptions ? `Run options — ${activeProfile || "custom"}` : "Run options"}
            onClick={openRunOptions}
          />
          <ToolbarSpacer />
          {status ? (
            <StatusPill tone={status.activeEngine === "maestro" ? "info" : "running"}>
              engine: {status.activeEngine}
            </StatusPill>
          ) : null}
        </Toolbar>
        <SplitPane direction="vertical" initialSizes={[0, 240]} flexIndex={0} minSize={120} storageKey="console">
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
        </SplitPane>
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
        <IconButton
          icon="settings"
          active={hasRunOptions}
          label={hasRunOptions ? `Run options — ${activeProfile || "custom"}` : "Run options"}
          onClick={openRunOptions}
        />
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
      <SplitPane direction="vertical" initialSizes={[0, 240]} flexIndex={0} minSize={120} storageKey="console">
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
              problems={problems.map((p) => ({ line: p.line, severity: p.severity, message: p.message }))}
              registerApi={(api) => (editorApi.current = api)}
              onChange={(v) => setBufferContent(activePath, v)}
              onSave={() => void saveFile(activePath)}
            />
          )}
        </div>
        <div className={styles.console}>
          <RunConsole />
        </div>
      </SplitPane>

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

    </div>
  );
}
