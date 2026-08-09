import { Button, IconButton, Select, StatusPill, Toolbar, ToolbarSpacer } from "@conductor/studio-ui";

import {
  connectSelectedDevice,
  disconnectSelectedDevice,
  refreshDevices,
  selectDevice,
  useDevices,
  useDeviceStreaming,
  useSelectedDeviceId,
} from "../../stores/deviceStore";
import { toggleRecording, useRecording } from "../../stores/recorderStore";
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
  const recording = useRecording();

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
        {streaming && showRecord ? (
          <IconButton
            icon="dot"
            label={recording ? "Stop recording" : "Record gestures into the open flow"}
            active={recording}
            onClick={toggleRecording}
          />
        ) : null}
        {recording && showRecord ? <StatusPill tone="error" pulse>REC</StatusPill> : null}
        {streaming ? (
          <Button size="sm" variant="secondary" icon="stop" onClick={() => void disconnectSelectedDevice()}>
            Disconnect
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            icon="play"
            disabled={!selectedId}
            onClick={() => void connectSelectedDevice()}
          >
            Connect
          </Button>
        )}
      </Toolbar>
      <div className={styles.stream}>
        <DeviceStream deviceId={streaming ? selectedId : null} />
      </div>
      {showInspector ? (
        <div className={styles.inspector}>
          <Inspector deviceId={selectedId} />
        </div>
      ) : null}
    </div>
  );
}
