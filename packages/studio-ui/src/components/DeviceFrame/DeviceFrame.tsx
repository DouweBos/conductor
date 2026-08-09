import type { ReactNode } from "react";

import styles from "./DeviceFrame.module.css";

export interface DeviceFrameProps {
  /** The live surface (canvas/img). Sized to fill the screen area. */
  children: ReactNode;
  /** Intrinsic device resolution — controls the aspect ratio. */
  width?: number;
  height?: number;
  /** Overlaid on the screen (e.g. tap markers, inspector highlight). */
  overlay?: ReactNode;
  label?: ReactNode;
}

export function DeviceFrame({
  children,
  width = 9,
  height = 19.5,
  overlay,
  label,
}: DeviceFrameProps) {
  return (
    <div className={styles.wrap}>
      <div className={styles.frame} style={{ aspectRatio: `${width} / ${height}` }}>
        <div className={styles.screen}>
          {children}
          {overlay ? <div className={styles.overlay}>{overlay}</div> : null}
        </div>
      </div>
      {label ? <div className={styles.label}>{label}</div> : null}
    </div>
  );
}
