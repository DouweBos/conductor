import { DeviceFrame, Icon, Spinner, StatusPill, type StatusTone } from "@conductor/studio-ui";
import { useRef } from "react";

import { useDeviceStream } from "../../hooks/useDeviceStream";
import type { ParityTarget, ParityTargetProgress } from "../../lib/types";
import { useDevices, useStreamError, useStreamPhase } from "../../stores/deviceStore";
import styles from "./ParityStreamGrid.module.css";

/**
 * The reference build on the left, every target build tiled beside it.
 *
 * All tiles are watch-only. A parity run is a controlled comparison: the flow
 * drives every device through the same journey, and a stray tap on one tile
 * would put that build on a different screen from the others — which is exactly
 * the divergence the run is trying to measure.
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
}: {
  deviceId: string | null;
  label: string;
  sublabel?: string;
  progress?: ParityTargetProgress;
  large?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stream = useDeviceStream(deviceId, canvasRef);
  const phase = useStreamPhase(deviceId);
  const streamError = useStreamError(deviceId);
  const connecting = phase === "connecting";

  return (
    <figure className={[styles.tile, large && styles.large].filter(Boolean).join(" ")}>
      <DeviceFrame width={stream.width || undefined} height={stream.height || undefined}>
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
}: {
  referenceDeviceId: string | null;
  referenceLabel: string;
  referenceProgress?: ParityTargetProgress;
  targets: ParityTarget[];
  progressFor: (label: string) => ParityTargetProgress | undefined;
}) {
  const devices = useDevices();
  const nameOf = (id: string): string => devices.find((d) => d.id === id)?.name ?? id;

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
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
