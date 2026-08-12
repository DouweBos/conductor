import { useMemo } from "react";

import type { CaptureElement, CaptureUiResult } from "../../lib/types";
import {
  elementsWithBounds,
  findElement,
  setHoveredRef,
  setSelectedRef,
  useHoveredRef,
  useSelectedRef,
} from "../../stores/inspectStore";
import styles from "./ElementAnnotations.module.css";

/**
 * Maestro-Studio-style element picking: every captured element is a box over the
 * stream. Hover highlights the smallest one under the cursor, clicking selects
 * it. Boxes are laid out in percentages so they track the scaled video.
 */
export function ElementAnnotations({ capture }: { capture: CaptureUiResult }) {
  const hoveredRef = useHoveredRef();
  const selectedRef = useSelectedRef();

  // Largest first, so the smallest element ends up on top and wins the pointer.
  const elements = useMemo(() => elementsWithBounds(capture.root), [capture]);
  const hovered = hoveredRef ? findElement(capture.root, hoveredRef) : null;
  const selected = selectedRef ? findElement(capture.root, selectedRef) : null;
  if (!capture.width || !capture.height) return null;

  return (
    <div className={styles.layer}>
      {elements.map((el) => (
        <button
          key={el.ref}
          type="button"
          className={styles.box}
          style={frameStyle(el, capture)}
          onPointerEnter={() => setHoveredRef(el.ref)}
          onPointerLeave={() => setHoveredRef(null)}
          onClick={(e) => {
            e.stopPropagation();
            setSelectedRef(el.ref);
          }}
          aria-label={el.identifier || el.text || el.role || el.ref}
        />
      ))}
      {/* Highlights live outside the hit boxes: a full-screen selection drawn
          on top would otherwise swallow every click under it. */}
      {selected?.bounds ? (
        <div className={[styles.highlight, styles.selected].join(" ")} style={frameStyle(selected, capture)} />
      ) : null}
      {hovered?.bounds && hovered.ref !== selected?.ref ? (
        <div className={styles.highlight} style={frameStyle(hovered, capture)} />
      ) : null}
    </div>
  );
}

function frameStyle(el: CaptureElement, screen: CaptureUiResult): React.CSSProperties {
  const b = el.bounds!;
  return {
    left: `${(b.x / screen.width) * 100}%`,
    top: `${(b.y / screen.height) * 100}%`,
    width: `${(b.width / screen.width) * 100}%`,
    height: `${(b.height / screen.height) * 100}%`,
  };
}
