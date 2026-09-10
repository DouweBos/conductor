import { DeviceFrame, Icon, Spinner, StatusPill, type StatusTone } from "@conductor/studio-ui";
import { useEffect, useRef, useState } from "react";

import { useDeviceStream } from "../../hooks/useDeviceStream";
import { mirrorInput, sendInput, type MirrorInput } from "../../lib/mirror";
import { remoteKeyFor } from "../../lib/remoteKeys";
import type { ParityTarget, ParityTargetProgress, Platform } from "../../lib/types";
import { isTvPlatform } from "../../lib/types";
import { useDevices, useStreamError, useStreamPhase } from "../../stores/deviceStore";
import styles from "./ParityStreamGrid.module.css";

/**
 * The reference build on the left, every target build tiled beside it.
 *
 * Whether a tile can be driven depends on how the comparison gets its screens.
 * While a flow is walking, every tile is watch-only: the flow drives all of
 * them through the same journey, and a stray tap would put one build on a
 * different screen from the others — exactly the divergence being measured.
 *
 * In a live session there is no flow, so the reference *must* be drivable —
 * that is how you get to the screen you want to compare. With mirroring on, the
 * same input goes to every target, which is what keeps four devices walking
 * together without a script.
 */

function toneFor(phase: ParityTargetProgress["phase"] | undefined): StatusTone {
  switch (phase) {
    case "walking":
      return "running";
    case "recorded":
      return "success";
    case "failed":
      return "error";
    default:
      return "neutral";
  }
}

function captionFor(progress: ParityTargetProgress | undefined): string {
  if (!progress) return "idle";
  switch (progress.phase) {
    case "walking":
      return progress.lastCheckpoint
        ? `${progress.checkpoints} · ${progress.lastCheckpoint}`
        : "walking…";
    case "recorded":
      return `${progress.checkpoints} checkpoint${progress.checkpoints === 1 ? "" : "s"}`;
    case "failed":
      return "failed";
    default:
      return "idle";
  }
}

function StreamTile({
  deviceId,
  label,
  sublabel,
  progress,
  large = false,
  platform,
  interactive = false,
  mirrorTo = [],
}: {
  deviceId: string | null;
  label: string;
  sublabel?: string;
  progress?: ParityTargetProgress;
  large?: boolean;
  platform?: Platform;
  /** Drivable — live mode's reference tile. */
  interactive?: boolean;
  /** Devices that receive a copy of every input sent here. */
  mirrorTo?: string[];
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const downRef = useRef<{ x: number; y: number } | null>(null);
  const stream = useDeviceStream(deviceId, canvasRef);
  const phase = useStreamPhase(deviceId);
  const streamError = useStreamError(deviceId);
  const connecting = phase === "connecting";
  const [focused, setFocused] = useState(false);
  // A TV has no touch screen — the remote is the only way in, so the overlay
  // takes keyboard focus rather than pointer gestures.
  const isTv = isTvPlatform(platform);

  useEffect(() => {
    if (interactive && isTv && stream.connected) overlayRef.current?.focus();
  }, [interactive, isTv, stream.connected]);

  const dispatch = (input: MirrorInput): void => {
    if (!deviceId) return;
    void sendInput(deviceId, input);
    if (mirrorTo.length) void mirrorInput(mirrorTo, input);
  };

  const normalize = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const el = overlayRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
    };
  };

  const overlay =
    interactive && deviceId ? (
      <div
        ref={overlayRef}
        className={[styles.overlay, focused && styles.overlayFocused].filter(Boolean).join(" ")}
        tabIndex={0}
        role="application"
        aria-label={`Drive ${label}${mirrorTo.length ? ` and ${mirrorTo.length} target(s)` : ""}`}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onPointerDown={(e) => {
          const p = normalize(e.clientX, e.clientY);
          if (p) downRef.current = p;
        }}
        onPointerUp={(e) => {
          const start = downRef.current;
          downRef.current = null;
          const end = normalize(e.clientX, e.clientY);
          if (!start || !end) return;
          const dist = Math.hypot(end.x - start.x, end.y - start.y);
          if (dist < 0.02) dispatch({ kind: "tap", x: end.x, y: end.y });
          else dispatch({ kind: "swipe", x1: start.x, y1: start.y, x2: end.x, y2: end.y });
        }}
        onKeyDown={(e) => {
          const remote = remoteKeyFor(e.key);
          if (remote) {
            e.preventDefault();
            dispatch({ kind: "key", key: remote });
          }
        }}
      />
    ) : null;

  return (
    <figure className={[styles.tile, large && styles.large].filter(Boolean).join(" ")}>
      <DeviceFrame
        width={stream.width || undefined}
        height={stream.height || undefined}
        overlay={overlay}
      >
        <canvas ref={canvasRef} className={styles.canvas} />
        {!stream.connected ? (
          <div className={styles.placeholder}>
            {connecting ? (
              <>
                <Spinner size={16} />
                <span>connecting…</span>
              </>
            ) : (
              <span className={styles.offline}>
                {streamError ?? (deviceId ? "not streaming" : "no device")}
              </span>
            )}
          </div>
        ) : null}
      </DeviceFrame>
      <figcaption className={styles.caption}>
        <span className={styles.label} title={label}>
          {label}
        </span>
        {interactive && mirrorTo.length > 0 ? (
          <span className={styles.mirror} title={`Input is copied to ${mirrorTo.length} target(s)`}>
            <Icon name="refresh" size={11} /> mirroring
          </span>
        ) : null}
        {sublabel ? <span className={styles.sub}>{sublabel}</span> : null}
        <StatusPill tone={toneFor(progress?.phase)}>{captionFor(progress)}</StatusPill>
      </figcaption>
      {progress?.error ? (
        <p className={styles.error} title={progress.error}>
          <Icon name="alert" size={12} /> {firstLine(progress.error)}
        </p>
      ) : null}
    </figure>
  );
}

function firstLine(text: string): string {
  const line = text.trim().split("\n").find(Boolean) ?? text;
  return line.length > 140 ? `${line.slice(0, 137)}…` : line;
}

export function ParityStreamGrid({
  referenceDeviceId,
  referenceLabel,
  referenceProgress,
  targets,
  progressFor,
  interactive = false,
  mirrorTo = [],
}: {
  referenceDeviceId: string | null;
  referenceLabel: string;
  referenceProgress?: ParityTargetProgress;
  targets: ParityTarget[];
  progressFor: (label: string) => ParityTargetProgress | undefined;
  /** Live mode: the reference can be driven by hand. */
  interactive?: boolean;
  /** Devices that receive a copy of what is done to the reference. */
  mirrorTo?: string[];
}) {
  const devices = useDevices();
  const nameOf = (id: string): string => devices.find((d) => d.id === id)?.name ?? id;
  const platformOf = (id: string | null): Platform | undefined =>
    id ? devices.find((d) => d.id === id)?.platform : undefined;

  return (
    <div className={styles.grid}>
      <div className={styles.referenceCol}>
        <h3 className={styles.colTitle}>Reference</h3>
        <StreamTile
          large
          deviceId={referenceDeviceId}
          label={referenceLabel}
          sublabel={referenceDeviceId ? nameOf(referenceDeviceId) : undefined}
          progress={referenceProgress}
          platform={platformOf(referenceDeviceId)}
          interactive={interactive}
          mirrorTo={mirrorTo}
        />
      </div>

      <div className={styles.targetCol}>
        <h3 className={styles.colTitle}>
          Targets{targets.length ? ` · ${targets.length}` : ""}
        </h3>
        {targets.length === 0 ? (
          <p className={styles.hint}>
            Add the builds to compare against — an Android TV emulator, a tvOS simulator, a Vega
            virtual device, a Lightning build in the browser.
          </p>
        ) : (
          <div
            className={styles.tiles}
            // Two across until there are more than four, then three: a 4-target
            // run is the common case and reads best as a 2x2.
            data-dense={targets.length > 4 ? "true" : undefined}
          >
            {targets.map((t) => (
              <StreamTile
                key={t.deviceId}
                deviceId={t.deviceId}
                label={t.label}
                sublabel={nameOf(t.deviceId)}
                progress={progressFor(t.label)}
                platform={t.platform}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
