import {
  Button,
  Icon,
  Panel,
  SegmentedControl,
  Select,
  StatusPill,
  Tag,
  TextField,
  Toolbar,
  ToolbarSpacer,
  type SelectOption,
  type StatusTone,
} from "@conductor/studio-ui";
import { useEffect, useMemo, useState } from "react";

import { launchAppOnDevice, listFlows } from "../../lib/ipc";
import type { DeviceInfo, FileEntry, ParityMode, ParityRunPhase } from "../../lib/types";
import { refreshDevices, useDevices } from "../../stores/deviceStore";
import {
  addParityTarget,
  cancelParityRun,
  mirrorTargets,
  progressFor,
  removeParityTarget,
  renameParityTarget,
  resetParitySession,
  setParityFlow,
  setParityMirror,
  setParityMode,
  setParityReference,
  setParityReferenceLabel,
  convergeOnLastSnap,
  snapParityNow,
  startParityRun,
  stopConvergence,
  syncParityStreams,
  useParityError,
  useParityFlow,
  useParityMatrix,
  useParityMirror,
  useParityMode,
  useParityProgress,
  useParityReference,
  useParityRunning,
  useParitySnapping,
  useParitySnaps,
  useParityTargets,
  useConverges,
  useCampaign,
  usePlan,
  addLastSnapToCampaign,
  useConvergeOptions,
  useConvergeRunning,
  setConvergeOptions,
  loadParityConfigIntoStore,
  resetRoute,
  setReferenceAppId,
  useParityConfig,
  useParityRoute,
  useReferenceAppId,
  useRecordingInteraction,
  useInteraction,
  setRecordingInteraction,
} from "../../stores/parityStore";
import { CampaignPanel } from "./CampaignPanel";
import { PlanPanel } from "./PlanPanel";
import { ConvergePanel } from "./ConvergePanel";
import { RecipeEditor } from "./RecipeEditor";
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
  const mode = useParityMode();
  const mirror = useParityMirror();
  const snaps = useParitySnaps();
  const snapping = useParitySnapping();
  const converges = useConverges();
  const campaign = useCampaign();
  const plan = usePlan();
  const converging = useConvergeRunning();
  const convergeOptions = useConvergeOptions();
  const route = useParityRoute();
  const referenceAppId = useReferenceAppId();
  const config = useParityConfig();
  const [editingRecipe, setEditingRecipe] = useState<string | null>(null);
  const recordingInteraction = useRecordingInteraction();
  const interaction = useInteraction();
  const [flows, setFlows] = useState<FileEntry[]>([]);
  const [snapName, setSnapName] = useState("");

  useEffect(() => {
    void refreshDevices();
    void listFlows().then(setFlows).catch(() => setFlows([]));
    void loadParityConfigIntoStore();
  }, []);

  // A fresh launch on every streamed device, and a fresh route from here: the
  // steps recorded after this are exactly what the loop replays after a rebuild.
  const launchAll = async (): Promise<void> => {
    const ids = [reference.deviceId, ...targets.map((t) => t.deviceId)].filter(Boolean) as string[];
    await Promise.allSettled(
      ids.map((id) => {
        const label = targets.find((t) => t.deviceId === id)?.label;
        const appId = (label && config.recipes[label]?.appId) || referenceAppId;
        return appId ? launchAppOnDevice(id, appId) : Promise.resolve();
      }),
    );
    resetRoute();
  };

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
  const canSnap = Boolean(
    reference.deviceId && targets.length > 0 && snapName.trim() && !snapping,
  );

  const capture = async (): Promise<void> => {
    await snapParityNow(snapName);
    // Clear the field so the next screen gets its own name rather than
    // silently piling up as "home-2", "home-3".
    setSnapName("");
  };

  return (
    <div className={styles.workspace}>
      <Toolbar>
        <SegmentedControl
          label="How screens are compared"
          value={mode}
          onChange={(v) => setParityMode(v as ParityMode)}
          options={[
            { value: "live", label: "Live" },
            { value: "flow", label: "Flow" },
          ]}
        />
        {mode === "flow" ? (
          <Select
            value={flowPath ?? ""}
            onChange={(e) => setParityFlow(e.target.value || null)}
            options={[{ value: "", label: "Pick a flow…" }, ...flowOptions]}
            aria-label="Flow to walk"
          />
        ) : (
          <>
            <TextField
              value={snapName}
              onChange={(e) => setSnapName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSnap) void capture();
              }}
              placeholder="Name this screen…"
              aria-label="Name for the screen being captured"
            />
            <Button size="sm" icon="camera" disabled={!canSnap} onClick={() => void capture()}>
              {snapping ? "Capturing…" : "Capture & compare"}
            </Button>
            <label className={styles.mirrorToggle}>
              <input
                type="checkbox"
                checked={mirror}
                onChange={(e) => setParityMirror(e.target.checked)}
              />
              Mirror input to targets
            </label>
            <label
              className={styles.mirrorToggle}
              title="After a capture, every input to the reference becomes a step that captures its own checkpoint on every device — press Down three times and each screen is held to parity"
            >
              <input
                type="checkbox"
                checked={recordingInteraction}
                disabled={snaps.length === 0 || converging}
                onChange={(e) => setRecordingInteraction(e.target.checked)}
              />
              Record interaction{interaction.length ? ` · ${interaction.length}` : ""}
            </label>
            <label className={styles.mirrorToggle} title="Every finding kind blocks, including layout drift and pixels">
              <input
                type="checkbox"
                checked={convergeOptions.strict}
                disabled={converging}
                onChange={(e) => setConvergeOptions({ strict: e.target.checked })}
              />
              Strict layout
            </label>
            <label className={styles.mirrorToggle} title="Agents run tool calls without asking. Off, they stop at the first prompt and the loop waits with them.">
              <input
                type="checkbox"
                checked={convergeOptions.autoApprove}
                disabled={converging}
                onChange={(e) => setConvergeOptions({ autoApprove: e.target.checked })}
              />
              Unattended
            </label>
            <label className={styles.mirrorToggle} title="Use a target's reload recipe instead of a full build when it has one">
              <input
                type="checkbox"
                checked={convergeOptions.preferReload}
                disabled={converging}
                onChange={(e) => setConvergeOptions({ preferReload: e.target.checked })}
              />
              Prefer reload
            </label>
            <label className={styles.mirrorToggle} title="A second agent reads the diff that reached parity and looks for a gamed pass before a human sees it">
              <input
                type="checkbox"
                checked={convergeOptions.adversarialReview}
                disabled={converging}
                onChange={(e) => setConvergeOptions({ adversarialReview: e.target.checked })}
              />
              Adversarial review
            </label>
            <label className={styles.mirrorToggle} title="On accept, commit the target's source dir (from its recipe)">
              <input
                type="checkbox"
                checked={convergeOptions.commitOnAccept}
                disabled={converging}
                onChange={(e) => setConvergeOptions({ commitOnAccept: e.target.checked })}
              />
              Commit on accept
            </label>
            {converging ? (
              <Button
                size="sm"
                variant="secondary"
                icon="stop"
                onClick={() => void stopConvergence()}
              >
                Stop agents
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  icon="agent"
                  disabled={snaps.length === 0 || targets.length === 0 || snapping}
                  title="Freeze the captured screen and let an agent work each target until it matches"
                  onClick={() => void convergeOnLastSnap()}
                >
                  Match it
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon="plus"
                  disabled={snaps.length === 0 || targets.length === 0 || snapping}
                  title="Queue the captured screen, with its route and targets, to be matched later with the rest"
                  onClick={() => void addLastSnapToCampaign()}
                >
                  Queue it
                </Button>
              </>
            )}
          </>
        )}
        <ToolbarSpacer />
        <StatusPill tone={phaseTone(phase, matrix?.passed)}>
          {phase ? PHASE_LABEL[phase] : "ready"}
        </StatusPill>
        {mode === "flow" ? (
          running ? (
            <Button
              size="sm"
              variant="secondary"
              icon="stop"
              onClick={() => void cancelParityRun()}
            >
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
          )
        ) : (
          <Button
            size="sm"
            variant="secondary"
            icon="trash"
            disabled={snaps.length === 0 || snapping}
            onClick={() => void resetParitySession()}
          >
            New session
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
            <TextField
              value={referenceAppId}
              onChange={(e) => setReferenceAppId(e.target.value)}
              placeholder="App id, e.g. com.example.app"
              aria-label="Reference app id"
            />
          </div>
          {mode === "live" ? (
            <div className={styles.routeBar}>
              <Button
                size="sm"
                variant="secondary"
                icon="play"
                disabled={!reference.deviceId || (!referenceAppId && targets.every((t) => !config.recipes[t.label]?.appId))}
                title="Launch the app on every device and start recording the route from here"
                onClick={() => void launchAll()}
              >
                Launch all
              </Button>
              <span className={styles.routeStatus}>
                {route.length === 0
                  ? "route: nothing recorded since launch"
                  : `route: ${route.length} step${route.length === 1 ? "" : "s"} recorded — replayed on each target after every rebuild`}
              </span>
              {route.length > 0 ? (
                <Button size="sm" variant="ghost" icon="close" onClick={resetRoute}>
                  Clear
                </Button>
              ) : null}
            </div>
          ) : null}
          <p className={styles.hint}>
            The build being ported <em>from</em>.{" "}
            {mode === "flow"
              ? "It walks the flow first — if the reference can't complete the journey there is nothing to hold the targets to, so the run stops there rather than spending every device to find out."
              : "Drive it to whatever screen you want compared; the targets are held to what it is showing when you capture."}
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
                      variant={config.recipes[t.label] ? "secondary" : "ghost"}
                      icon="settings"
                      title={
                        config.recipes[t.label]
                          ? "Edit how this target is rebuilt and relaunched"
                          : "No recipe: the agent will have to rebuild and navigate itself"
                      }
                      onClick={() => setEditingRecipe((v) => (v === t.label ? null : t.label))}
                    >
                      {config.recipes[t.label]?.build || config.recipes[t.label]?.reload
                        ? "recipe"
                        : "no recipe"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="close"
                      aria-label={`Remove ${t.label}`}
                      disabled={running}
                      onClick={() => removeParityTarget(t.deviceId)}
                    />
                    {editingRecipe === t.label ? (
                      <div className={styles.recipeSlot}>
                        <RecipeEditor
                          target={t}
                          recipe={config.recipes[t.label]}
                          onClose={() => setEditingRecipe(null)}
                        />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>

      {mode === "live" ? (
        <Panel
          title={`Captured screens · ${snaps.length}`}
          actions={
            snaps.length ? (
              <span className={styles.snapList}>
                {snaps.map((name, i) => (
                  <Tag key={`${name}-${i}`}>{name}</Tag>
                ))}
              </span>
            ) : null
          }
        >
          <p className={styles.hint}>
            No flow. Drive the reference to the screen you want — mirroring sends the same taps and
            remote presses to every target, so they walk with it — then <strong>Capture &amp;
            compare</strong> to diff what all of them are showing right now.
            <br />
            Then press <strong>Match it</strong>: the captured screen is frozen as the goal, and
            each target gets its own agent that fixes, rebuilds, re-navigates and is measured again,
            round after round, until the diff says it matches. The agent never decides it is
            finished — the diff does.
          </p>
        </Panel>
      ) : null}

      <Panel title="Devices" flush>
        <div className={styles.streams}>
          <ParityStreamGrid
            referenceDeviceId={reference.deviceId}
            referenceLabel={reference.label}
            referenceProgress={progress?.reference}
            targets={targets}
            progressFor={(label) => progressFor(progress, label)}
            // Only live mode hands the reference over: while a flow is walking,
            // a stray tap is the divergence, not the measurement.
            interactive={mode === "live" && !running && !converging}
            mirrorTo={converging ? [] : mirrorTargets()}
          />
        </div>
      </Panel>

      <PlanPanel
        plan={plan}
        canCapture={Boolean(reference.deviceId) && targets.length > 0 && !running && !converging}
      />

      <CampaignPanel campaign={campaign} />

      {[...converges].reverse().map((c) => (
        <ConvergePanel key={c.goalId} converge={c} />
      ))}

      <ParityResults matrix={matrix} />
    </div>
  );
}
