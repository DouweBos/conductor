import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import styles from "./SplitPane.module.css";

export interface SplitPaneProps {
  /** Panels to lay out. Two or more; N-1 draggable gutters are inserted. */
  children: ReactNode[];
  direction?: "horizontal" | "vertical";
  /** Initial size (px) of every panel except the last, which flexes. */
  initialSizes?: number[];
  minSize?: number;
  className?: string;
}

export function SplitPane({
  children,
  direction = "horizontal",
  initialSizes,
  minSize = 120,
  className,
}: SplitPaneProps) {
  const panels = children.filter((c) => c != null);
  const [sizes, setSizes] = useState<number[]>(
    () => initialSizes ?? panels.slice(0, -1).map(() => 240),
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const dragIndex = useRef<number | null>(null);

  const horizontal = direction === "horizontal";

  const onMove = useCallback(
    (clientPos: number) => {
      const idx = dragIndex.current;
      if (idx == null || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const origin = horizontal ? rect.left : rect.top;
      const before = sizes.slice(0, idx).reduce((a, b) => a + b, 0);
      const next = Math.max(minSize, clientPos - origin - before);
      setSizes((prev) => {
        const copy = [...prev];
        copy[idx] = next;
        return copy;
      });
    },
    [horizontal, minSize, sizes],
  );

  useEffect(() => {
    const handleMouse = (e: MouseEvent) =>
      onMove(horizontal ? e.clientX : e.clientY);
    const stop = () => {
      dragIndex.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", handleMouse);
    window.addEventListener("mouseup", stop);
    return () => {
      window.removeEventListener("mousemove", handleMouse);
      window.removeEventListener("mouseup", stop);
    };
  }, [horizontal, onMove]);

  const startDrag = (idx: number) => {
    dragIndex.current = idx;
    document.body.style.cursor = horizontal ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  const cls = [styles.split, horizontal ? styles.horizontal : styles.vertical, className]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={containerRef} className={cls}>
      {panels.map((panel, i) => {
        const isLast = i === panels.length - 1;
        const size = sizes[i];
        return (
          <div key={i} className={styles.pane} style={isLast ? undefined : sizeStyle(horizontal, size)}>
            {panel}
            {!isLast && (
              <div
                className={styles.gutter}
                role="separator"
                aria-orientation={horizontal ? "vertical" : "horizontal"}
                onMouseDown={() => startDrag(i)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function sizeStyle(horizontal: boolean, size: number) {
  return horizontal
    ? { width: size, flex: "0 0 auto" as const }
    : { height: size, flex: "0 0 auto" as const };
}
