import { create } from "zustand";

import type { FlowRunStatus, FlowStep, RunLogLine } from "../lib/types";

interface RunState {
  runId: string | null;
  flowPath: string | null;
  /** Device the run is on — the runner picks one when the caller doesn't. */
  deviceId: string | null;
  status: FlowRunStatus | null;
  lines: RunLogLine[];
  steps: FlowStep[];
  screenshot: string | null;
}

const store = create<RunState>(() => ({
  runId: null,
  flowPath: null,
  deviceId: null,
  status: null,
  lines: [],
  steps: [],
  screenshot: null,
}));

export const useRunId = () => store((s) => s.runId);
export const useRunStatus = () => store((s) => s.status);
export const useRunLines = () => store((s) => s.lines);
export const useRunFlowPath = () => store((s) => s.flowPath);
export const useRunDeviceId = () => store((s) => s.deviceId);
export const useRunSteps = () => store((s) => s.steps);
export const useRunScreenshot = () => store((s) => s.screenshot);

export function beginRun(runId: string, flowPath: string, deviceId?: string): void {
  store.setState({
    runId,
    flowPath,
    deviceId: deviceId ?? store.getState().deviceId,
    status: "running",
    lines: [],
    steps: [],
    screenshot: null,
  });
}

export function appendRunLine(line: RunLogLine): void {
  store.setState((s) => ({ lines: [...s.lines, line] }));
}

export function setRunStatus(status: FlowRunStatus): void {
  store.setState({ status });
}

export function setRunSteps(steps: FlowStep[]): void {
  store.setState({ steps });
}

export function setRunScreenshot(screenshot: string): void {
  store.setState({ screenshot });
}

export function appendReplLines(lines: RunLogLine[]): void {
  store.setState((s) => ({ lines: [...s.lines, ...lines] }));
}
