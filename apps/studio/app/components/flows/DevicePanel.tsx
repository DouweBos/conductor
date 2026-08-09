import { Button, IconButton, Select, Toolbar, ToolbarSpacer } from "@conductor/studio-ui";

import {
  connectSelectedDevice,
  disconnectSelectedDevice,
  refreshDevices,
  selectDevice,
  useDevices,
  useDeviceStreaming,
  useSelectedDeviceId,
} from "../../stores/deviceStore";
import { DeviceStream } from "./DeviceStream";
import { Inspector } from "./Inspector";
import styles from "./DevicePanel.module.css";

export function DevicePanel() {
  const devices = useDevices();
  const selectedId = useSelectedDeviceId();
  const streaming = useDeviceStreaming();

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
      <div className={styles.inspector}>
        <Inspector deviceId={selectedId} />
      </div>
    </div>
  );
}
