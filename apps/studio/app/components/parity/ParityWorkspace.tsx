import {
  Button,
  Icon,
  Panel,
  Select,
  StatusPill,
  TextField,
  Toolbar,
  ToolbarSpacer,
  type SelectOption,
  type StatusTone,
} from "@conductor/studio-ui";
import { useEffect, useMemo, useState } from "react";

import { listFlows } from "../../lib/ipc";
import type { DeviceInfo, FileEntry, ParityRunPhase } from "../../lib/types";
import { refreshDevices, useDevices } from "../../stores/deviceStore";
import {
  addParityTarget,
  cancelParityRun,
  progressFor,
  removeParityTarget,
  renameParityTarget,
  setParityFlow,
  setParityReference,
  setParityReferenceLabel,
  startParityRun,
  syncParityStreams,
  useParityError,
  useParityFlow,
  useParityMatrix,
  useParityProgress,
  useParityReference,
  useParityRunning,
  useParityTargets,
} from "../../stores/parityStore";
import { ParityResults } from "./ParityResults";
import { ParityStreamGrid } from "./ParityStreamGrid";
import styles from "./ParityWorkspace.module.css";

/** The flow tree, flattened to the files a run can walk. */
function flattenFlows(entries: FileEntry[]): FileEntry[] {
  const out: FileEntry[] = [];
  const walk = (list: FileEntry[]): void => {
    for (const e of list) {
      if (e.type === "file") out.push(e);
      if (e.children) walk(e.children);
    }
  };
  walk(entries);
  return out;
}

const PHASE_LABEL: Record<ParityRunPhase, string> = {
  idle: "ready",
  "recording-reference": "recording reference",
  "walking-targets": "walking targets",
  diffing: "diffing",
  done: "done",
  failed: "failed",
};

function phaseTone(phase: ParityRunPhase | undefined, passed: boolean | undefined): StatusTone {
  if (phase === "failed") return "error";
  if (phase === "done") return passed ? "success" : "warning";
  if (phase === undefined || phase === "idle") return "neutral";
  return "running";
}

export function ParityWorkspace() {
  const devices = useDevices();
  const flowPath = useParityFlow();
  const reference = useParityReference();
  const targets = useParityTargets();
  const progress = useParityProgress();
  const matrix = useParityMatrix();
  const running = useParityRunning();
  const error = useParityError();
  const [flows, setFlows] = useState<FileEntry[]>([]);

  useEffect(() => {
    void refreshDevices();
    void listFlows().then(setFlows).catch(() => setFlows([]));
  }, []);

  // Keep the streams matching the plan, so adding a target lights its tile up
  // immediately rather than at the start of the next run.
  useEffect(() => {
    if (!running) void syncParityStreams();
  }, [reference.deviceId, targets, running]);

  const flowOptions: SelectOption[] = useMemo(
    () =>
      flattenFlows(flows)
        .filter((f) => /\.ya?ml$/.test(f.path))
        .map((f) => ({ value: f.path, label: f.path })),
    [flows],
  );

  const referenceOptions: SelectOption[] = useMemo(
    () => devices.map((d) => ({ value: d.id, label: `${d.name} · ${d.platform}` })),
    [devices],
  );

  // A device can be the reference or a target, never both — comparing a build
  // against itself is always green and always meaningless.
  const available: DeviceInfo[] = devices.filter(
    (d) => d.id !== reference.deviceId && !targets.some((t) => t.deviceId === d.id),
  );

  const phase = progress?.phase;

  return (
    <div className={styles.workspace}>
      <Toolbar>
        <Select
          value={flowPath ?? ""}
          onChange={(e) => setParityFlow(e.target.value || null)}
          options={[{ value: "", label: "Pick a flow…" }, ...flowOptions]}
          aria-label="Flow to walk"
        />
        <ToolbarSpacer />
        <StatusPill tone={phaseTone(phase, matrix?.passed)}>
          {phase ? PHASE_LABEL[phase] : "ready"}
        </StatusPill>
        {running ? (
          <Button size="sm" variant="secondary" icon="stop" onClick={() => void cancelParityRun()}>
            Cancel
          </Button>
        ) : (
          <Button
            size="sm"
            icon="play"
            disabled={!flowPath || !reference.deviceId || targets.length === 0}
            onClick={() => void startParityRun()}
          >
            Run parity
          </Button>
        )}
      </Toolbar>

      {error ? (
        <p className={styles.error}>
          <Icon name="alert" size={13} /> {error}
        </p>
      ) : null}

      <div className={styles.setup}>
        <Panel title="Reference build">
          <div className={styles.field}>
            <Select
              value={reference.deviceId ?? ""}
              onChange={(e) => setParityReference(e.target.value || null)}
              options={[{ value: "", label: "Pick the device…" }, ...referenceOptions]}
              aria-label="Reference device"
            />
            <TextField
              value={reference.label}
              onChange={(e) => setParityReferenceLabel(e.target.value)}
              placeholder="Reference"
              aria-label="Reference name"
            />
          </div>
          <p className={styles.hint}>
            The build being ported <em>from</em>. It walks the flow first — if the reference can't
            complete the journey there is nothing to hold the targets to, so the run stops there
            rather than spending every device to find out.
          </p>
        </Panel>

        <Panel
          title={`Targets · ${targets.length}`}
          actions={
            <Select
              value=""
              onChange={(e) => {
                const device = devices.find((d) => d.id === e.target.value);
                if (device) addParityTarget(device);
              }}
              options={[
                { value: "", label: available.length ? "Add a target…" : "No devices left" },
                ...available.map((d) => ({ value: d.id, label: `${d.name} · ${d.platform}` })),
              ]}
              aria-label="Add target device"
            />
          }
        >
          {targets.length === 0 ? (
            <p className={styles.hint}>
              Add every build the reference is being compared against. They all walk the journey at
              once, on their own devices — an Apple TV simulator, an Android TV emulator, a Vega
              virtual device and a Lightning build in the browser can all be targets of one run.
            </p>
          ) : (
            <ul className={styles.targetList}>
              {targets.map((t) => {
                const p = progressFor(progress, t.label);
                return (
                  <li key={t.deviceId} className={styles.target}>
                    <TextField
                      value={t.label}
                      onChange={(e) => renameParityTarget(t.deviceId, e.target.value)}
                      aria-label={`Name for ${t.deviceId}`}
                    />
                    <span className={styles.targetDevice}>
                      {devices.find((d) => d.id === t.deviceId)?.name ?? t.deviceId}
                    </span>
                    <span className={styles.targetPlatform}>{t.platform}</span>
                    {p?.phase === "failed" ? <StatusPill tone="error">failed</StatusPill> : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="close"
                      aria-label={`Remove ${t.label}`}
                      disabled={running}
                      onClick={() => removeParityTarget(t.deviceId)}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Devices" flush>
        <div className={styles.streams}>
          <ParityStreamGrid
            referenceDeviceId={reference.deviceId}
            referenceLabel={reference.label}
            referenceProgress={progress?.reference}
            targets={targets}
            progressFor={(label) => progressFor(progress, label)}
          />
        </div>
      </Panel>

      <ParityResults matrix={matrix} />
    </div>
  );
}
