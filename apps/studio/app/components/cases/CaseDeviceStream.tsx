import { StatusPill } from "@conductor/studio-ui";
import { useEffect } from "react";

import {
  followDevice,
  useDeviceConnecting,
  useDeviceError,
  useDevices,
  useDeviceStreaming,
  useSelectedDeviceId,
} from "../../stores/deviceStore";
import { useRunDeviceId } from "../../stores/runStore";
import { DeviceStream } from "../flows/DeviceStream";
import styles from "./CasesView.module.css";

/**
 * The screen the test is on — and nothing else. No picker, no boot or install,
 * no taps: the case chose the device when it started the run, so the only
 * question this answers is "what is happening right now".
 */
export function CaseDeviceStream() {
  const runDeviceId = useRunDeviceId();
  const selectedId = useSelectedDeviceId();
  const streaming = useDeviceStreaming();
  const connecting = useDeviceConnecting();
  const devices = useDevices();
  const error = useDeviceError();

  // Follow whatever the run landed on, including a device it picked itself.
  useEffect(() => {
    if (runDeviceId) void followDevice(runDeviceId);
  }, [runDeviceId]);

  const deviceId = runDeviceId ?? selectedId;
  const device = devices.find((d) => d.id === deviceId);

  return (
    <div className={styles.streamPane}>
      <div className={styles.streamHead}>
        <span className={styles.streamName}>{device?.name ?? deviceId ?? "No device"}</span>
        {connecting ? <StatusPill tone="running">attaching…</StatusPill> : null}
        {error ? <StatusPill tone="error">{error}</StatusPill> : null}
      </div>
      <div className={styles.deviceStream}>
        <DeviceStream deviceId={streaming ? deviceId : null} interactive={false} />
      </div>
    </div>
  );
}
