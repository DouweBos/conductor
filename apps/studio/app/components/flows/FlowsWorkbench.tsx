import { SplitPane } from "@conductor/studio-ui";
import { useEffect } from "react";

import { useRoute } from "../../lib/router";
import { openFile } from "../../stores/flowStore";
import { refreshDevices } from "../../stores/deviceStore";
import { DevicePanel } from "./DevicePanel";
import { EditorPane } from "./EditorPane";
import { FlowSidebar } from "./FlowSidebar";
import styles from "./FlowsWorkbench.module.css";

export function FlowsWorkbench() {
  const route = useRoute();
  const activePath = route.flowPath;

  // Load the file whenever the URL points at one.
  useEffect(() => {
    if (activePath) void openFile(activePath);
  }, [activePath]);

  // Discover devices once when the workbench mounts.
  useEffect(() => {
    void refreshDevices();
  }, []);

  return (
    <SplitPane
      className={styles.workbench}
      initialSizes={["20%", 0, "32%"]}
      flexIndex={1}
      minSize={180}
      storageKey="workbench"
    >
      <div className={styles.sidebar}>
        <FlowSidebar activePath={activePath} />
      </div>
      <div className={styles.center}>
        <EditorPane activePath={activePath} />
      </div>
      <div className={styles.device}>
        <DevicePanel />
      </div>
    </SplitPane>
  );
}
