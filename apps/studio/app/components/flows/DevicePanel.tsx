import {
  Button,
  IconButton,
  SegmentedControl,
  Select,
  StatusPill,
  Toolbar,
  ToolbarSpacer,
} from "@conductor/studio-ui";

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
              icon="search"
              label="Re-capture elements"
              disabled={!selectedId || capturing}
              onClick={() => selectedId && void refreshCapture(selectedId)}
            />
        ) : null}
        {streaming && showRecord ? (
          <IconButton
            icon="dot"
            label={recording ? "Stop recording" : "Record gestures into the open flow"}
            active={recording}
            onClick={toggleRecording}
          />
        ) : null}
        {recording && showRecord ? <StatusPill tone="error" pulse>REC</StatusPill> : null}
      </Toolbar>
      ) : null}
      {error && !streaming ? <div className={styles.error}>{error}</div> : null}
      <div className={styles.stream}>
        <DeviceStream deviceId={streaming ? selectedId : null} />
      </div>
      {showInspector ? (
        <div className={styles.inspector}>
          {mode === "inspect" && capture ? (
            <CommandSuggestions capture={capture} platform={device?.platform ?? "ios"} />
          ) : (
            <Inspector deviceId={selectedId} />
          )}
        </div>
      ) : null}
    </div>
  );
}
