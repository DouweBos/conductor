import { ContextMenu } from "@conductor/studio-ui";
import { useMemo, useState } from "react";

import type { CaptureElement, CaptureUiResult } from "../../lib/types";
import {
  elementsAtPoint,
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
 *
 * The smallest box wins the pointer, which makes a parent unreachable when a
 * child covers it — right-click instead and pick from the whole stack.
 */
export function ElementAnnotations({ capture }: { capture: CaptureUiResult }) {
  const hoveredRef = useHoveredRef();
  const selectedRef = useSelectedRef();
  const [stack, setStack] = useState<{ x: number; y: number; elements: CaptureElement[] } | null>(null);

  // Largest first, so the smallest element ends up on top and wins the pointer.
  // Boxes cover the a11y elements; right-click reaches the containers around them.
  const elements = useMemo(() => elementsWithBounds(capture.root, true), [capture]);
  const hovered = hoveredRef ? findElement(capture.root, hoveredRef) : null;
  const selected = selectedRef ? findElement(capture.root, selectedRef) : null;
  if (!capture.width || !capture.height) return null;

  // Right-click offers everything under the point, innermost first.
  const openStack = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * capture.width;
    const y = ((event.clientY - rect.top) / rect.height) * capture.height;
    const under = elementsAtPoint(capture.root, x, y);
    if (under.length > 0) setStack({ x: event.clientX, y: event.clientY, elements: under });
  };

  const closeStack = () => {
    setStack(null);
    setHoveredRef(null);
  };

  return (
    <div className={styles.layer} onContextMenu={openStack}>
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
      {stack ? (
        <ContextMenu
          open
          x={stack.x}
          y={stack.y}
          items={stack.elements.map((el, depth) => ({
            // NBSP, since the menu renders labels as HTML and would eat spaces.
            label: `${"\u00a0\u00a0".repeat(depth)}${labelFor(el)}`,
            icon: el.ref === selectedRef ? ("check" as const) : undefined,
            onClick: () => setSelectedRef(el.ref),
            onHover: (on: boolean) => setHoveredRef(on ? el.ref : null),
          }))}
          onClose={closeStack}
        />
      ) : null}
    </div>
  );
}

/** Enough to tell two boxes in the same stack apart. */
function labelFor(el: CaptureElement): string {
  const name = el.identifier || el.text;
  // A node with no name is a wrapper; its path-shaped ref tells you nothing.
  if (!name) return el.role || "Group";
  return el.role ? `${el.role} · ${name}` : name;
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
