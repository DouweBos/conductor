import { useMemo } from "react";

import type { CaptureElement, CaptureUiResult } from "../../lib/types";
import { elementsWithBounds, setHoveredRef, setSelectedRef, useHoveredRef, useSelectedRef } from "../../stores/inspectStore";
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
  if (!capture.width || !capture.height) return null;

  return (
    <div className={styles.layer}>
      {elements.map((el) => (
        <Annotation
          key={el.ref}
          element={el}
          screen={capture}
          state={el.ref === selectedRef ? "selected" : el.ref === hoveredRef ? "hovered" : "idle"}
        />
      ))}
    </div>
  );
}

function Annotation({
  element,
  screen,
  state,
}: {
  element: CaptureElement;
  screen: CaptureUiResult;
  state: "idle" | "hovered" | "selected";
}) {
  const b = element.bounds!;
  return (
    <button
      type="button"
      className={[styles.box, styles[state]].join(" ")}
      style={{
        left: `${(b.x / screen.width) * 100}%`,
        top: `${(b.y / screen.height) * 100}%`,
        width: `${(b.width / screen.width) * 100}%`,
        height: `${(b.height / screen.height) * 100}%`,
      }}
      onPointerEnter={() => setHoveredRef(element.ref)}
      onPointerLeave={() => setHoveredRef(null)}
      onClick={(e) => {
        e.stopPropagation();
        setSelectedRef(element.ref);
      }}
      aria-label={element.identifier || element.text || element.role || element.ref}
    />
  );
}
