import { Button, IconButton } from "@conductor/studio-ui";

import {
  openRunOptions,
  useActiveProfile,
  useHasRunOptions,
} from "../../stores/runOptionsStore";
import { toggleTheme, useResolvedTheme } from "../../stores/themeStore";
import { ProjectMenu } from "./ProjectMenu";
import { UpdaterBadge } from "./UpdaterBadge";
import styles from "./TitleBar.module.css";

export function TitleBar() {
  const theme = useResolvedTheme();
  const hasRunOptions = useHasRunOptions();
  const activeProfile = useActiveProfile();
  return (
    <header className={styles.titleBar}>
      <div className={styles.trafficLightSpace} />
      <div className={styles.title}>
        <span className={styles.app}>Conductor Studio</span>
        <ProjectMenu />
      </div>
      <div className={styles.right}>
        {/* Run options belong to the session, not to the open flow, so they're
            reachable from the chrome — and the active profile stays visible. */}
        <Button
          variant="ghost"
          size="sm"
          icon="settings"
          title="Run options — env variables, tags and profiles for every run"
          onClick={openRunOptions}
        >
          {activeProfile || (hasRunOptions ? "Custom run options" : "Run options")}
        </Button>
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
