import { DeviceFrame, EmptyState, Spinner, StatusPill } from "@conductor/studio-ui";
import { useEffect, useRef, useState } from "react";

import { useDeviceStream } from "../../hooks/useDeviceStream";
import { deviceSwipe, deviceTap, devicePressKey } from "../../lib/ipc";
import { recordKey, recordSwipe, recordTap } from "../../lib/recorder";
import { remoteKeyFor } from "../../lib/remoteKeys";
import { useDevices } from "../../stores/deviceStore";
import { useCapture, useDeviceMode } from "../../stores/inspectStore";
import { isRecording } from "../../stores/recorderStore";
import { ElementAnnotations } from "./ElementAnnotations";
import styles from "./DeviceStream.module.css";

interface Point {
  x: number;
  y: number;
}

export function DeviceStream({
  deviceId,
  interactive = true,
}: {
  deviceId: string | null;
  /** False for a watch-only view: no taps, no swipes, no element overlay. */
  interactive?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const downRef = useRef<{ point: Point; t: number } | null>(null);
  const stream = useDeviceStream(deviceId, canvasRef);
  const mode = useDeviceMode();
  const capture = useCapture();
  const inspecting = mode === "inspect";
  const platform = useDevices().find((d) => d.id === deviceId)?.platform;
  // A TV has no touch screen — the remote is the only way in, so the overlay
  // takes keyboard focus instead of pointer gestures.
  const isTv = platform === "tvos";
  const [focused, setFocused] = useState(false);

  // Arm the remote as soon as a TV is live, so arrow keys work without the
  // user having to guess that the screen needs clicking first.
  useEffect(() => {
    if (isTv && stream.connected) overlayRef.current?.focus();
  }, [isTv, stream.connected]);

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

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!deviceId) return;
    const key = remoteKeyFor(e.key);
    if (!key) return;
    e.preventDefault();
    // Auto-repeat would fire dozens of presses (and dozens of steps) for one
    // held key. A held D-pad is still one press to the device and one step.
    if (e.repeat) return;
    void devicePressKey(deviceId, key);
    if (isRecording()) recordKey(key);
  };

  if (!deviceId) {
    return interactive ? (
      <EmptyState icon="device" title="No device selected" description="Pick a device above." />
    ) : (
      <EmptyState
        icon="device"
        title="Nothing running"
        description="Run a case and its device appears here."
      />
    );
  }

  const showRemoteHint = interactive && isTv && !inspecting && !focused;

  return (
    <DeviceFrame
      width={stream.width || 9}
      height={stream.height || 19.5}
      label={
        <>
          {stream.connected ? (
            <StatusPill tone="success" pulse>
              live · {stream.width}×{stream.height}
            </StatusPill>
          ) : stream.error ? (
            <StatusPill tone="error">{stream.error}</StatusPill>
          ) : (
            <Spinner size={14} label="Connecting…" />
          )}
          {/* Under the frame, not floating on the screen — over TV content a
              dark centred pill just reads as a fake dynamic island. */}
          {showRemoteHint ? <StatusPill tone="info">Click to use the remote</StatusPill> : null}
        </>
      }
      overlay={
        !interactive ? null : inspecting ? (
          capture ? <ElementAnnotations capture={capture} /> : null
        ) : (
          <div
            ref={overlayRef}
            className={[styles.overlay, isTv && styles.remote].filter(Boolean).join(" ")}
            // Focusable so it can receive arrow keys; on a TV that's the only input.
            tabIndex={isTv ? 0 : undefined}
            role={isTv ? "application" : undefined}
            aria-label={isTv ? "Device remote — arrow keys navigate, Enter selects" : undefined}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={isTv ? onKeyDown : undefined}
            onPointerDown={isTv ? undefined : onPointerDown}
            onPointerUp={isTv ? undefined : onPointerUp}
          />
        )
      }
    >
      <canvas ref={canvasRef} className={styles.canvas} />
    </DeviceFrame>
  );
}
