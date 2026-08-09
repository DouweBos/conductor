import type { FlowRun } from "../app/lib/types";
import type { DeviceStreamSession } from "./services/device/deviceService";

/**
 * The single in-memory app state. Node is single-threaded so plain Maps need no
 * locking (same pattern as Argus's AppState).
 */
class AppState {
  /** Absolute path of the currently opened project (repo) root. */
  projectRoot: string | null = null;

  /** Active device stream sessions, keyed by device id. */
  readonly deviceStreams = new Map<string, DeviceStreamSession>();

  /** Active/most-recent flow runs, keyed by run id. */
  readonly flowRuns = new Map<string, FlowRun>();
}

export const appState = new AppState();
