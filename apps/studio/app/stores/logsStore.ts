import { create } from "zustand";

import { startLogs as ipcStart, stopLogs as ipcStop } from "../lib/ipc";
import type { RunLogLine } from "../lib/types";

const MAX_LINES = 2000;

interface LogsState {
  deviceId: string | null;
  streaming: boolean;
  lines: RunLogLine[];
}

const store = create<LogsState>(() => ({ deviceId: null, streaming: false, lines: [] }));

export const useLogLines = () => store((s) => s.lines);
export const useLogsStreaming = () => store((s) => s.streaming);

export function appendLog(line: RunLogLine): void {
  store.setState((s) => {
    const lines = [...s.lines, line];
    return { lines: lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines };
  });
}

export async function startDeviceLogs(deviceId: string): Promise<void> {
  store.setState({ deviceId, streaming: true, lines: [] });
  try {
    await ipcStart(deviceId);
  } catch (err) {
    appendLog({ id: `log-start-err`, tone: "error", text: String(err) });
    store.setState({ streaming: false });
  }
}

export async function stopDeviceLogs(): Promise<void> {
  const { deviceId } = store.getState();
  store.setState({ streaming: false });
  if (deviceId) await ipcStop(deviceId).catch(() => {});
}
