import {
  Icon,
  IconButton,
  LogView,
  StatusPill,
  StepList,
  type StatusTone,
} from "@conductor/studio-ui";
import { useState } from "react";

import { useIpcEvent } from "../../hooks/useIpcEvent";
import { cancelRun, runCommand, runFlowInline } from "../../lib/ipc";
import { getCurrentRoute } from "../../lib/router";
import type { FlowRunStatus, RunLogLine } from "../../lib/types";
import { useSelectedDeviceId } from "../../stores/deviceStore";
import { useFlowBuffers } from "../../stores/flowStore";
import {
  appendLog,
  startDeviceLogs,
  stopDeviceLogs,
  useLogLines,
  useLogsStreaming,
} from "../../stores/logsStore";
import {
  appendReplLines,
  beginRun,
  useRunId,
  useRunLines,
  useRunScreenshot,
  useRunStatus,
  useRunSteps,
} from "../../stores/runStore";
import { ProblemList } from "./ProblemList";
import { RunHistory } from "./RunHistory";
import { refreshProblems, useProblems } from "../../stores/problemStore";
import styles from "./RunConsole.module.css";

type Tab = "console" | "steps" | "logs" | "problems" | "runs";
type ReplMode = "cmd" | "maestro";

const STATUS_TONE: Record<FlowRunStatus, StatusTone> = {
  running: "running",
  passed: "success",
  failed: "error",
  cancelled: "warning",
  error: "error",
};

let replSeq = 0;

function activeAppId(buffers: Record<string, { content: string }>): string | undefined {
  const path = getCurrentRoute().flowPath;
  const content = path ? buffers[path]?.content : undefined;
  const match = content?.match(/^appId:\s*(.+)$/m);
  return match?.[1]?.trim();
}

export function RunConsole() {
  const runId = useRunId();
  const lines = useRunLines();
  const status = useRunStatus();
  const steps = useRunSteps();
  const screenshot = useRunScreenshot();
  const deviceId = useSelectedDeviceId();
  const buffers = useFlowBuffers();
  const logLines = useLogLines();
  const logsStreaming = useLogsStreaming();
  const [tab, setTab] = useState<Tab>("console");
  const problems = useProblems();
  const [mode, setMode] = useState<ReplMode>("cmd");
  const [command, setCommand] = useState("");

  // Run events are subscribed app-wide in useRunEvents; this view only reads.
  useIpcEvent<RunLogLine>(deviceId ? `device_logs:${deviceId}` : null, appendLog);

  const submit = async () => {
    const text = command.trim();
    if (!text || !deviceId) return;
    if (mode === "maestro") {
      try {
        const { runId: id } = await runFlowInline(text, deviceId, activeAppId(buffers));
        beginRun(id, "(repl)");
        setTab("steps");
      } catch (err) {
        appendReplLines([{ id: `repl-err-${(replSeq += 1)}`, tone: "error", text: String(err) }]);
      }
      setCommand("");
      return;
    }
    replSeq += 1;
    const seq = replSeq;
    appendReplLines([{ id: `repl-${seq}-cmd`, tone: "command", text: `> ${text}` }]);
    setTab("console");
    setCommand("");
    try {
      const result = await runCommand(text, deviceId);
      const tone = result.ok ? "success" : "error";
      const out: RunLogLine[] = result.output
        .split(/\r?\n/)
        .filter((l) => l.length)
        .map((t, i) => ({ id: `repl-${seq}-${i}`, text: t, tone }));
      appendReplLines(out.length ? out : [{ id: `repl-${seq}-ok`, tone, text: result.ok ? "ok" : "failed" }]);
    } catch (err) {
      appendReplLines([{ id: `repl-${seq}-err`, tone: "error", text: String(err) }]);
    }
  };

  const toggleLogs = () => {
    if (logsStreaming) void stopDeviceLogs();
    else if (deviceId) void startDeviceLogs(deviceId);
  };

  return (
    <div className={styles.console}>
      <div className={styles.header}>
        <div className={styles.tabs}>
          <TabButton label="Console" active={tab === "console"} onClick={() => setTab("console")} />
          <TabButton
            label={steps.length ? `Steps (${steps.length})` : "Steps"}
            active={tab === "steps"}
            onClick={() => setTab("steps")}
          />
          <TabButton label="Logs" active={tab === "logs"} onClick={() => setTab("logs")} />
          <TabButton label="Runs" active={tab === "runs"} onClick={() => setTab("runs")} />
          <TabButton
            label={problems.length ? `Problems (${problems.length})` : "Problems"}
            active={tab === "problems"}
            onClick={() => setTab("problems")}
          />
        </div>
        {status ? (
          <StatusPill tone={STATUS_TONE[status]} pulse={status === "running"}>
            {status}
          </StatusPill>
        ) : null}
        <div className={styles.spacer} />
        {tab === "logs" ? (
          <button type="button" className={styles.smallBtn} onClick={toggleLogs} disabled={!deviceId}>
            {logsStreaming ? "Stop logs" : "Start logs"}
          </button>
        ) : null}
        {status === "running" && runId ? (
          <IconButton icon="stop" label="Stop run" onClick={() => void cancelRun(runId)} />
        ) : null}
      </div>

      <div className={styles.body}>
        {tab === "console" ? (
          <LogView lines={lines} emptyLabel="Run a flow or type a command below." />
        ) : null}
        {tab === "steps" ? (
          <div className={styles.steps}>
            <StepList steps={steps.map((s) => ({ id: s.id, label: s.label, status: s.status }))} />
            {screenshot ? (
              <div className={styles.shot}>
                <div className={styles.shotLabel}>Screen at failure</div>
                <img className={styles.shotImg} src={screenshot} alt="Screenshot at failure" />
              </div>
            ) : null}
            {steps.length === 0 && !screenshot ? (
              <div className={styles.emptyHint}>Step results appear here while a flow runs.</div>
            ) : null}
          </div>
        ) : null}
        {tab === "logs" ? (
          <LogView lines={logLines} emptyLabel="Start logs to stream device output." />
        ) : null}
        {tab === "problems" ? <ProblemList problems={problems} onRefresh={refreshProblems} /> : null}
        {tab === "runs" ? <RunHistory /> : null}
      </div>

      <div className={styles.repl}>
        <select
          className={styles.mode}
          value={mode}
          onChange={(e) => setMode(e.target.value as ReplMode)}
          aria-label="REPL mode"
        >
          <option value="cmd">conductor</option>
          <option value="maestro">maestro</option>
        </select>
        <div className={styles.inputWrap}>
          <Icon name="terminal" size={14} className={styles.prompt} />
          <input
            className={styles.input}
            aria-label={mode === "maestro" ? "Run a Maestro step" : "Run a conductor command"}
            placeholder={
              !deviceId
                ? "Connect a device to use the REPL"
                : mode === "maestro"
                  ? 'Run a Maestro step — e.g. - tapOn: "Login"'
                  : 'Run a conductor command — e.g. tap-on "Login"'
            }
            value={command}
            disabled={!deviceId}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
          />
        </div>
      </div>
    </div>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={[styles.tab, active && styles.tabActive].filter(Boolean).join(" ")}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
