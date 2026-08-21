import type { AppFingerprint, DeviceInfo, FlowRun } from "../app/lib/types";
import type { DeviceStreamSession } from "./services/device/deviceService";

/**
 * The single in-memory app state. Node is single-threaded so plain Maps need no
 * locking (same pattern as Argus's AppState).
 */
class AppState {
  /** Absolute path of the currently opened project (repo) root. */
  projectRoot: string | null = null;

  /** App identified by the most recent capture — scopes the active scene graph. */
  currentApp: AppFingerprint | null = null;

  /** Device the running agent drives — reports read it instead of trusting the model. */
  agentDevice: DeviceInfo | null = null;

  /** Active device stream sessions, keyed by device id. */
  readonly deviceStreams = new Map<string, DeviceStreamSession>();

  /** Active/most-recent flow runs, keyed by run id. */
  readonly flowRuns = new Map<string, FlowRun>();

  /**
   * The most recent device action (e.g. `tapOn: "Login"`), consumed by the
   * scene-graph builder on the next capture-ui to label a transition edge.
   */
  lastAction: string | null = null;
}

export const appState = new AppState();
