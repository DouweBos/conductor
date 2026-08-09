import { Icon, IconButton, LogView, StatusPill, type StatusTone } from "@conductor/studio-ui";
import { useState } from "react";

import { useIpcEvent } from "../../hooks/useIpcEvent";
import { cancelRun, runCommand } from "../../lib/ipc";
import type { FlowRun, FlowRunStatus, RunLogLine } from "../../lib/types";
import { useSelectedDeviceId } from "../../stores/deviceStore";
import {
  appendReplLines,
  appendRunLine,
  setRunStatus,
  useRunId,
  useRunLines,
  useRunStatus,
} from "../../stores/runStore";
import styles from "./RunConsole.module.css";

const STATUS_TONE: Record<FlowRunStatus, StatusTone> = {
  running: "running",
  passed: "success",
  failed: "error",
  cancelled: "warning",
  error: "error",
};

let replSeq = 0;

export function RunConsole() {
  const runId = useRunId();
  const lines = useRunLines();
  const status = useRunStatus();
  const deviceId = useSelectedDeviceId();
  const [command, setCommand] = useState("");

  useIpcEvent<RunLogLine>(runId ? `flow_run_output:${runId}` : null, appendRunLine);
  useIpcEvent<FlowRun>(runId ? `flow_run_status:${runId}` : null, (run) => setRunStatus(run.status));

  const submitCommand = async () => {
    const cmd = command.trim();
    if (!cmd || !deviceId) return;
    replSeq += 1;
    const seq = replSeq;
    appendReplLines([{ id: `repl-${seq}-cmd`, tone: "command", text: `> ${cmd}` }]);
    setCommand("");
    try {
      const result = await runCommand(cmd, deviceId);
      const tone = result.ok ? "success" : "error";
      const out: RunLogLine[] = result.output
        .split(/\r?\n/)
        .filter((l) => l.length)
        .map((text, i) => ({ id: `repl-${seq}-${i}`, text, tone }));
      appendReplLines(out.length ? out : [{ id: `repl-${seq}-ok`, tone, text: result.ok ? "ok" : "failed" }]);
    } catch (err) {
      appendReplLines([{ id: `repl-${seq}-err`, tone: "error", text: String(err) }]);
    }
  };

  return (
    <div className={styles.console}>
      <div className={styles.header}>
        <span className={styles.title}>Console</span>
        {status ? <StatusPill tone={STATUS_TONE[status]} pulse={status === "running"}>{status}</StatusPill> : null}
        <div className={styles.spacer} />
        {status === "running" && runId ? (
          <IconButton icon="stop" label="Stop run" onClick={() => void cancelRun(runId)} />
        ) : null}
      </div>
      <div className={styles.output}>
        <LogView lines={lines} emptyLabel="Run a flow or type a conductor command below." />
      </div>
      <div className={styles.repl}>
        <Icon name="terminal" size={14} className={styles.prompt} />
        <input
          className={styles.input}
          placeholder={deviceId ? "conductor command… (e.g. tap-on \"Login\")" : "Connect a device to use the REPL"}
          value={command}
          disabled={!deviceId}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submitCommand()}
        />
      </div>
    </div>
  );
}
