import { DeviceFrame, EmptyState, Spinner, StatusPill } from "@conductor/studio-ui";
import { useRef } from "react";

import { useDeviceStream } from "../../hooks/useDeviceStream";
import { deviceSwipe, deviceTap } from "../../lib/ipc";
import { recordSwipe, recordTap } from "../../lib/recorder";
import { useCapture, useDeviceMode } from "../../stores/inspectStore";
import { isRecording } from "../../stores/recorderStore";
import { ElementAnnotations } from "./ElementAnnotations";
import styles from "./DeviceStream.module.css";

interface Point {
  x: number;
  y: number;
}

export function DeviceStream({ deviceId }: { deviceId: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const downRef = useRef<{ point: Point; t: number } | null>(null);
  const stream = useDeviceStream(deviceId, canvasRef);
  const mode = useDeviceMode();
  const capture = useCapture();
  const inspecting = mode === "inspect";

  const toNormalized = (clientX: number, clientY: number): Point | null => {
    const el = overlayRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const p = toNormalized(e.clientX, e.clientY);
    if (p) downRef.current = { point: p, t: Date.now() };
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!deviceId) return;
    const start = downRef.current;
    downRef.current = null;
    const end = toNormalized(e.clientX, e.clientY);
    if (!start || !end) return;
    const dx = end.x - start.point.x;
    const dy = end.y - start.point.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.02) {
      void deviceTap(deviceId, end.x, end.y);
      if (isRecording()) void recordTap(deviceId, end.x, end.y);
    } else {
      void deviceSwipe(deviceId, start.point.x, start.point.y, end.x, end.y);
      if (isRecording()) recordSwipe(start.point.x, start.point.y, end.x, end.y);
    }
  };

  if (!deviceId) {
    return <EmptyState icon="device" title="No device selected" description="Pick a device above." />;
  }

  return (
    <DeviceFrame
      width={stream.width || 9}
      height={stream.height || 19.5}
      label={
        stream.connected ? (
          <StatusPill tone="success" pulse>
            live · {stream.width}×{stream.height}
          </StatusPill>
        ) : stream.error ? (
          <StatusPill tone="error">{stream.error}</StatusPill>
        ) : (
          <Spinner size={14} label="Connecting…" />
        )
      }
      overlay={
        inspecting ? (
          capture ? <ElementAnnotations capture={capture} /> : null
        ) : (
          <div
            ref={overlayRef}
            className={styles.overlay}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
          />
        )
      }
    >
      <canvas ref={canvasRef} className={styles.canvas} />
    </DeviceFrame>
  );
}
