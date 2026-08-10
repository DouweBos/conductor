import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import styles from "./SplitPane.module.css";

export interface SplitPaneProps {
  /** Panels to lay out. Two or more; N-1 draggable gutters are inserted. */
  children: ReactNode[];
  direction?: "horizontal" | "vertical";
  /** Size (px) of each panel. The entry for {@link flexIndex} is ignored. */
  initialSizes?: number[];
  /** Which panel absorbs the leftover space. Defaults to the last. */
  flexIndex?: number;
  minSize?: number;
  /** Remembers the sizes across sessions when set. */
  storageKey?: string;
  className?: string;
}

function loadSizes(key: string | undefined, fallback: number[]): number[] {
  if (!key) return fallback;
  try {
    const raw = window.localStorage.getItem(`splitpane:${key}`);
    const parsed = raw ? (JSON.parse(raw) as number[]) : null;
    return Array.isArray(parsed) && parsed.length === fallback.length ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function SplitPane({
  children,
  direction = "horizontal",
  initialSizes,
  flexIndex,
  minSize = 120,
  storageKey,
  className,
}: SplitPaneProps) {
  const panels = children.filter((child) => child != null);
  const flex = flexIndex ?? panels.length - 1;
  const [sizes, setSizes] = useState<number[]>(() =>
    loadSizes(storageKey, initialSizes ?? panels.map(() => 240)),
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const dragIndex = useRef<number | null>(null);
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;

  const horizontal = direction === "horizontal";

  const onMove = useCallback(
    (clientPos: number) => {
      const gutter = dragIndex.current;
      if (gutter == null || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const start = horizontal ? rect.left : rect.top;
      const total = horizontal ? rect.width : rect.height;
      const current = sizesRef.current;
      // A gutter before the flexing panel resizes the panel on its left; one
      // after it resizes the panel on its right. Either way the flexing panel
      // takes up the slack.
      const target = gutter < flex ? gutter : gutter + 1;
      const fixed = (from: number, to: number) =>
        current.slice(from, to).reduce((sum, size, i) => (from + i === flex ? sum : sum + size), 0);

      let next: number;
      let room: number;
      if (target < flex) {
        const before = fixed(0, target);
        next = clientPos - start - before;
        room = total - before - fixed(target + 1, current.length);
      } else {
        const after = fixed(target + 1, current.length);
        next = start + total - clientPos - after;
        room = total - after - fixed(0, target);
      }

      const clamped = Math.max(minSize, Math.min(next, room - minSize));
      setSizes((prev) => {
        const copy = [...prev];
        copy[target] = clamped;
        return copy;
      });
    },
    [flex, horizontal, minSize],
  );

  useEffect(() => {
    const handleMouse = (event: MouseEvent) => onMove(horizontal ? event.clientX : event.clientY);
    const stop = () => {
      if (dragIndex.current == null) return;
      dragIndex.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (storageKey) {
        try {
          window.localStorage.setItem(`splitpane:${storageKey}`, JSON.stringify(sizesRef.current));
        } catch {
          // Layout memory is a nicety; never break resizing over it.
        }
      }
    };
    window.addEventListener("mousemove", handleMouse);
    window.addEventListener("mouseup", stop);
    return () => {
      window.removeEventListener("mousemove", handleMouse);
      window.removeEventListener("mouseup", stop);
    };
  }, [horizontal, onMove, storageKey]);

  const startDrag = (index: number) => {
    dragIndex.current = index;
    document.body.style.cursor = horizontal ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  const cls = [styles.split, horizontal ? styles.horizontal : styles.vertical, className]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={containerRef} className={cls}>
      {panels.map((panel, index) => (
        <div
          key={index}
          className={[styles.pane, index === flex ? styles.flexing : ""].join(" ")}
          style={index === flex ? undefined : sizeStyle(horizontal, sizes[index] ?? minSize)}
        >
          {panel}
          {index < panels.length - 1 && (
            <div
              className={styles.gutter}
              role="separator"
              aria-orientation={horizontal ? "vertical" : "horizontal"}
              onMouseDown={() => startDrag(index)}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function sizeStyle(horizontal: boolean, size: number) {
  return horizontal
    ? { width: size, flex: "0 0 auto" as const }
    : { height: size, flex: "0 0 auto" as const };
}
