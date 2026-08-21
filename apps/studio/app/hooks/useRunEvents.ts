import { useIpcEvent } from "./useIpcEvent";
import type { FlowRun, FlowStep, RunLogLine } from "../lib/types";
import {
  appendRunLine,
  setRunScreenshot,
  setRunStatus,
  setRunSteps,
  useRunId,
} from "../stores/runStore";

/**
 * Keep the run store fed for the whole app's lifetime, not just while the view
 * that started the run happens to be mounted.
 *
 * These used to be subscribed inside the console and the cases rail, so
 * switching to Reports mid-run dropped every step and status update that
 * arrived while you were away — the run carried on, Studio just stopped
 * listening, and coming back showed a test frozen where you left it.
 */
export function useRunEvents(): void {
  const runId = useRunId();

  useIpcEvent<RunLogLine>(runId ? `flow_run_output:${runId}` : null, appendRunLine);
  useIpcEvent<FlowRun>(runId ? `flow_run_status:${runId}` : null, (run) => setRunStatus(run.status));
  useIpcEvent<FlowStep[]>(runId ? `flow_run_steps:${runId}` : null, setRunSteps);
  useIpcEvent<string>(runId ? `flow_run_screenshot:${runId}` : null, setRunScreenshot);
}
