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
import { referenceSpanOnLine, resolveReference } from "../../lib/flowRefs";
import { flowForSteps, parseSteps, stepAt, stepsInRange, stepsUntil } from "../../lib/flowSteps";
import { maestroCompletion } from "../../lib/maestroCompletion";
import { appNavigate, selectFlow } from "../../lib/router";
import type { FlowCatalog, LintProblem, MaestroStatus } from "../../lib/types";
import { useSelectedDeviceId } from "../../stores/deviceStore";
import {
  closeFile,
  languageFor,
  saveFile,
  setBufferContent,
  clearReveal,
  useBuffer,
  useFlowBuffers,
  useOpenTabs,
  useReveal,
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
  const reveal = useReveal();
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

  // Everything I touched since main — the set worth running before pushing.
  const runChanged = async () => {
    const changed = await changedFlows();
    if (changed.length === 0) return;
    for (const flow of changed) {
      const { runId } = await runFlow(flow, deviceId ?? undefined, getRunOptions());
      beginRun(runId, flow);
    }
  };

  // Jump to a global-search hit, once its file has actually finished loading.
  useEffect(() => {
    if (!reveal || reveal.path !== activePath || buffer?.loading !== false) return;
    editorApi.current?.revealLine(reveal.line);
    clearReveal();
  }, [reveal, activePath, buffer?.loading]);

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

  // Run whole steps, not the raw selection: a selection ending on the
  // `- assertVisible:` line but not its indented body is a command with no
  // value, which the engine rejects rather than running.
  const runSelection = async () => {
    const api = editorApi.current;
    const content = buffer?.content;
    if (!api || !content || !api.getSelection().trim()) return;
    const { from, to } = api.getSelectedLines();
    const chosen = stepsInRange(steps, from, to);
    if (chosen.length === 0) return;
    await runSteps(chosen, "selection");
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

  // Cmd-click a `runFlow: …` reference to open the file it names in a tab.
  const targetOnLine = (lineText: string) => {
    const span = referenceSpanOnLine(lineText);
    if (!span) return null;
    const target = resolveReference(span.raw, activePath ?? "", catalog.current.aliases);
    if (!target || !catalog.current.entries.some((e) => e.path === target)) return null;
    return { span, target };
  };

  const followLine = (lineText: string) => {
    const hit = targetOnLine(lineText);
    if (hit) selectFlow(hit.target);
  };

  const followSpanOnLine = (lineText: string) => targetOnLine(lineText)?.span ?? null;

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
        <SplitPane direction="vertical" initialSizes={[0, "28%"]} flexIndex={0} minSize={120} storageKey="console">
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
      <Tabs
        tabs={tabs}
        activeId={activePath}
        onSelect={selectFlow}
        onClose={(path) => {
          const next = closeFile(path);
          // Closing a background tab leaves the URL — and the editor — alone.
          if (path !== activePath) return;
          if (next) selectFlow(next);
          // Not setView: that would restore the tab just closed.
          else appNavigate({ view: "flows" });
        }}
      />
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
      <SplitPane direction="vertical" initialSizes={[0, "28%"]} flexIndex={0} minSize={120} storageKey="console">
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
              followSpanOnLine={followSpanOnLine}
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
