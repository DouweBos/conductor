import type { CSSProperties } from "react";

/**
 * The single icon component for Conductor Studio. No inline <svg> is allowed in
 * the app or in other components — add new glyphs here at a 1.6 stroke weight on
 * a 24x24 viewBox. Icons inherit `currentColor` so they theme automatically.
 */
export type IconName =
  | "file"
  | "folder"
  | "copy"
  | "folderOpen"
  | "play"
  | "stop"
  | "refresh"
  | "plus"
  | "close"
  | "search"
  | "chevronLeft"
  | "chevronRight"
  | "chevronDown"
  | "device"
  | "sun"
  | "moon"
  | "agent"
  | "matrix"
  | "code"
  | "terminal"
  | "tag"
  | "check"
  | "alert"
  | "settings"
  | "tap"
  | "flow"
  | "dot"
  | "record"
  | "camera"
  | "trash";

const PATHS: Record<IconName, string> = {
  file: "M7 3h7l5 5v13H7zM14 3v5h5",
  copy: "M9 9V5.5A1.5 1.5 0 0 1 10.5 4h8A1.5 1.5 0 0 1 20 5.5v8a1.5 1.5 0 0 1-1.5 1.5H15M5.5 9h8A1.5 1.5 0 0 1 15 10.5v8a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 4 18.5v-8A1.5 1.5 0 0 1 5.5 9z",
  folder: "M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h7A1.5 1.5 0 0 1 19 9v9.5A1.5 1.5 0 0 1 17.5 20h-13A1.5 1.5 0 0 1 3 18.5z",
  folderOpen: "M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10M3 7.5V18a1 1 0 0 0 1 1h13.2a1 1 0 0 0 .95-.68L21 11H6.2a1 1 0 0 0-.95.68z",
  play: "M8 5.5v13l11-6.5z",
  stop: "M7 7h10v10H7z",
  refresh: "M20 11a8 8 0 1 0-.9 5M20 5v6h-6",
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6L6 18",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  chevronLeft: "M15 6l-6 6 6 6",
  chevronRight: "M9 6l6 6-6 6",
  chevronDown: "M6 9l6 6 6-6",
  device: "M8 3h8a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 16 21H8a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 8 3zM11 18h2",
  sun: "M12 6.5v-3M12 20.5v-3M6.5 12h-3M20.5 12h-3M7 7L5 5M19 19l-2-2M17 7l2-2M5 19l2-2M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z",
  moon: "M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z",
  agent: "M9 3h6a2 2 0 0 1 2 2v3H7V5a2 2 0 0 1 2-2zM5 8h14a1 1 0 0 1 1 1v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a1 1 0 0 1 1-1zM9.5 13v1.5M14.5 13v1.5",
  matrix: "M4 4h16v16H4zM4 10h16M4 15h16M10 4v16M15 4v16",
  code: "M9 8l-4 4 4 4M15 8l4 4-4 4",
  terminal: "M5 5h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM7 9l3 2.5L7 14M12.5 14.5h4",
  tag: "M4 4h7l9 9-7 7-9-9zM8 8h.01",
  check: "M5 12.5l4.5 4.5L19 7.5",
  alert: "M12 4l9 15H3zM12 10v4M12 17h.01",
  settings: "M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM19 12a7 7 0 0 0-.1-1l2-1.6-2-3.4-2.4 1a7 7 0 0 0-1.7-1l-.3-2.5H10.5l-.3 2.5a7 7 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 1.7 1l.3 2.5h3.8l.3-2.5a7 7 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6c.06-.33.1-.66.1-1z",
  tap: "M9 4v9M9 9l2 8 1.5-1 2 3 2-1-2-3 2-1z",
  flow: "M6 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM18 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM8 7h6a2 2 0 0 1 2 2v6",
  dot: "M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  // A record button reads as a solid circle; `dot` is the 4px list bullet.
  record: "M12 5.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z",
  camera: "M3.5 9h3.1l1.4-2h8l1.4 2h3.1v9.5H3.5zM12 11a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4z",
  trash: "M5 7h14M10 7V5h4v2M7 7l1 12.5h8L17 7M10.5 10.5v6M13.5 10.5v6",
};

const FILLED: Partial<Record<IconName, boolean>> = {
  play: true,
  record: true,
  stop: true,
  dot: true,
};

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

/**
 * Build an icon as a detached SVG, for the few places that construct DOM
 * imperatively (the editor's gutter). Same glyphs as {@link Icon}.
 */
export function iconElement(name: IconName, size = 16): SVGSVGElement {
  const filled = FILLED[name];
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", filled ? "currentColor" : "none");
  svg.setAttribute("stroke", filled ? "none" : "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", PATHS[name]);
  svg.append(path);
  return svg;
}

export function Icon({ name, size = 16, className, style, title }: IconProps) {
  const filled = FILLED[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      style={style}
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Namespaced access, mirroring Peacock's `Icons` usage. */
export const Icons = { Icon };
