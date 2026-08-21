import { ContextMenu, Icon, type ContextMenuItem } from "@conductor/studio-ui";
import { useEffect, useState } from "react";

import { useIpcEvent } from "../../hooks/useIpcEvent";
import type { ProjectInfo } from "../../lib/types";
import {
  chooseProject,
  listRecentProjects,
  openProjectAt,
  setProject,
  useProject,
} from "../../stores/projectStore";
import styles from "./TitleBar.module.css";

/** Project name in the title bar → recent projects + a folder picker. */
export function ProjectMenu() {
  const project = useProject();
  const [recents, setRecents] = useState<ProjectInfo[]>([]);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  useIpcEvent<ProjectInfo>("project:opened", setProject);

  // Kept warm so the menu opens on the click rather than after a round-trip.
  useEffect(() => {
    listRecentProjects()
      .then(setRecents)
      .catch(() => setRecents([]));
  }, [project?.root]);

  const items: ContextMenuItem[] = recents.map((entry) => ({
    label: entry.name,
    icon: entry.root === project?.root ? "check" : "folder",
    disabled: entry.root === project?.root,
    onClick: () => void openProjectAt(entry.root),
  }));
  items.push({ label: "Open project…", icon: "folderOpen", onClick: () => void chooseProject() });

  return (
    <>
      <button
        type="button"
        className={styles.project}
        onClick={(e) => {
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          setAnchor(anchor ? null : { x: rect.left, y: rect.bottom + 4 });
        }}
        title={project?.root ?? "Open a project"}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
      >
        <span>{project ? project.name : "Open project…"}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      <ContextMenu
        open={anchor !== null}
        x={anchor?.x ?? 0}
        y={anchor?.y ?? 0}
        items={items}
        onClose={() => setAnchor(null)}
      />
    </>
  );
}
