import { create } from "zustand";

import type { FlowRunStatus, RunLogLine } from "../lib/types";

interface RunState {
  runId: string | null;
  flowPath: string | null;
  status: FlowRunStatus | null;
  lines: RunLogLine[];
}

const store = create<RunState>(() => ({
  runId: null,
  flowPath: null,
  status: null,
  lines: [],
}));

export const useRunId = () => store((s) => s.runId);
export const useRunStatus = () => store((s) => s.status);
export const useRunLines = () => store((s) => s.lines);
export const useRunFlowPath = () => store((s) => s.flowPath);

export function beginRun(runId: string, flowPath: string): void {
  store.setState({ runId, flowPath, status: "running", lines: [] });
}

export function appendRunLine(line: RunLogLine): void {
  store.setState((s) => ({ lines: [...s.lines, line] }));
}

export function setRunStatus(status: FlowRunStatus): void {
  store.setState({ status });
}

export function appendReplLines(lines: RunLogLine[]): void {
  store.setState((s) => ({ lines: [...s.lines, ...lines] }));
}
