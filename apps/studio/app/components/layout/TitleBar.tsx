import { IconButton } from "@conductor/studio-ui";

import { useProject } from "../../stores/projectStore";
import { toggleTheme, useResolvedTheme } from "../../stores/themeStore";
import { UpdaterBadge } from "./UpdaterBadge";
import styles from "./TitleBar.module.css";

export function TitleBar() {
  const project = useProject();
  const theme = useResolvedTheme();
  return (
    <header className={styles.titleBar}>
      <div className={styles.trafficLightSpace} />
      <div className={styles.title}>
        <span className={styles.app}>Conductor Studio</span>
        {project ? <span className={styles.project}>· {project.name}</span> : null}
      </div>
      <div className={styles.right}>
        <UpdaterBadge />
        <IconButton
          icon={theme === "dark" ? "sun" : "moon"}
          label="Toggle theme"
          onClick={toggleTheme}
        />
      </div>
    </header>
  );
}
