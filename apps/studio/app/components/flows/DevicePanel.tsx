import {
  Button,
  IconButton,
  SegmentedControl,
  Select,
  SplitPane,
  StatusPill,
  Toolbar,
  ToolbarSpacer,
} from "@conductor/studio-ui";
import { useState } from "react";

import {
  connectSelectedDevice,
  disconnectSelectedDevice,
  refreshDevices,
  selectDevice,
  useDeviceConnecting,
  useDeviceError,
  useDevices,
  useDeviceStreaming,
  useSelectedDeviceId,
} from "../../stores/deviceStore";
import { installApp, startDevice } from "../../lib/ipc";
import { recordAssertion } from "../../lib/recorder";
import {
  refreshCapture,
  setMode,
  useCapture,
  useCaptureLoading,
  useDeviceMode,
} from "../../stores/inspectStore";
import { toggleRecording, useRecording } from "../../stores/recorderStore";
import { CommandSuggestions } from "./CommandSuggestions";
import { DeviceStream } from "./DeviceStream";
import { Inspector } from "./Inspector";
import styles from "./DevicePanel.module.css";

export interface DevicePanelProps {
  /** Gesture recording appends to the open flow, so it's flows-only. */
  showRecord?: boolean;
  showInspector?: boolean;
}

export function DevicePanel({ showRecord = true, showInspector = true }: DevicePanelProps = {}) {
  const devices = useDevices();
  const selectedId = useSelectedDeviceId();
  const streaming = useDeviceStreaming();
  const connecting = useDeviceConnecting();
  const error = useDeviceError();
  const recording = useRecording();
  const mode = useDeviceMode();
  const capturing = useCaptureLoading();
  const capture = useCapture();
  const device = devices.find((d) => d.id === selectedId) ?? null;

  // Inspect mode is only useful with a fresh snapshot, so take one on entry.
  const [busy, setBusy] = useState<string | null>(null);

  // Booting a sim and installing a build are part of the loop; conductor can do
  // both, so there's no reason to leave Studio for them.
  const boot = async () => {
    if (!device) return;
    setBusy("Booting…");
    try {
      await startDevice(device.platform, device.id);
      await refreshDevices();
    } finally {
      setBusy(null);
    }
  };

  const install = async () => {
    if (!selectedId) return;
    const appPath = window.prompt("Path to the .app / .ipa / .apk to install");
    if (!appPath) return;
    setBusy("Installing…");
    try {
      await installApp(selectedId, appPath);
    } finally {
      setBusy(null);
    }
  };

  const changeMode = (next: "interact" | "inspect") => {
    setMode(next);
    if (next === "inspect" && selectedId) void refreshCapture(selectedId);
  };

  const options = devices.map((d) => ({
    value: d.id,
    label: `${d.name}${d.state === "booted" ? " · booted" : ""}`,
  }));

  return (
    <div className={styles.panel}>
      <Toolbar>
        <Select
          options={options}
          placeholder={devices.length ? "Select device…" : "No devices found"}
          value={selectedId ?? ""}
          onChange={(e) => selectDevice(e.target.value)}
          className={styles.select}
        />
        <IconButton icon="refresh" label="Refresh devices" onClick={() => void refreshDevices()} />
        <ToolbarSpacer />
        {busy ? <StatusPill tone="running">{busy}</StatusPill> : null}
        {device && device.state !== "booted" ? (
          <Button size="sm" variant="secondary" icon="device" disabled={!!busy} onClick={() => void boot()}>
            Boot
          </Button>
        ) : null}
        <IconButton
          icon="plus"
          label="Install a build on this device"
          disabled={!selectedId || !!busy}
          onClick={() => void install()}
        />
        {streaming ? (
          <Button size="sm" variant="secondary" icon="stop" onClick={() => void disconnectSelectedDevice()}>
            Disconnect
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            icon="play"
            disabled={!selectedId || connecting}
            onClick={() => void connectSelectedDevice()}
          >
            {connecting ? "Connecting…" : "Connect"}
          </Button>
        )}
      </Toolbar>
      {showInspector ? (
        <Toolbar>
          <SegmentedControl
            label="Device mode"
            options={[
              { value: "interact", label: "Interact" },
              { value: "inspect", label: "Inspect" },
            ]}
            value={mode}
            onChange={(v) => changeMode(v as "interact" | "inspect")}
          />
          <span className={styles.modeHint}>
            {mode === "inspect"
              ? "Click an element for commands"
              : "Taps and swipes drive the device"}
          </span>
          <ToolbarSpacer />
          {mode === "inspect" ? (
            <IconButton
              icon="camera"
              label="Re-capture elements"
              disabled={!selectedId || capturing}
              onClick={() => selectedId && void refreshCapture(selectedId)}
            />
        ) : null}
        {streaming && showRecord ? (
          <Button
            size="sm"
            variant={recording ? "primary" : "ghost"}
            icon="record"
            onClick={toggleRecording}
            title={
              recording
                ? "Stop recording"
                : "Append your taps and swipes to the open flow as Maestro steps"
            }
          >
            {recording ? "Stop" : "Record"}
          </Button>
        ) : null}
        {recording && showRecord ? (
          <Button
            size="sm"
            variant="secondary"
            icon="check"
            disabled={!selectedId}
            onClick={() => selectedId && void recordAssertion(selectedId)}
            title="Append an assertVisible for what's on screen now"
          >
            Assert
          </Button>
        ) : null}
        {recording && showRecord ? <StatusPill tone="error" pulse>REC</StatusPill> : null}
      </Toolbar>
      ) : null}
      {error && !streaming ? <div className={styles.error}>{error}</div> : null}
      {showInspector ? (
        <SplitPane
          direction="vertical"
          initialSizes={[0, 260]}
          flexIndex={0}
          minSize={120}
          storageKey="inspector"
        >
          <div className={styles.stream}>
            <DeviceStream deviceId={streaming ? selectedId : null} />
          </div>
          <div className={styles.inspector}>
            {mode === "inspect" && capture ? (
              <CommandSuggestions capture={capture} platform={device?.platform ?? "ios"} />
            ) : (
              <Inspector deviceId={selectedId} />
            )}
          </div>
        </SplitPane>
      ) : (
        <div className={styles.stream}>
          <DeviceStream deviceId={streaming ? selectedId : null} />
        </div>
      )}
    </div>
  );
}
