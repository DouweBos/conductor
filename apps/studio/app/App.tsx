import { AgentView } from "./components/agent/AgentView";
import { CasesView } from "./components/cases/CasesView";
import { FlowsWorkbench } from "./components/flows/FlowsWorkbench";
import { ReportsView } from "./components/reports/ReportsView";
import { RunOptionsDialog } from "./components/runOptions/RunOptionsDialog";
import { NavRail } from "./components/layout/NavRail";
import { TitleBar } from "./components/layout/TitleBar";
import { useRunEvents } from "./hooks/useRunEvents";
import { useRoute } from "./lib/router";
import styles from "./App.module.css";

export function App() {
  const route = useRoute();
  // App-level, so a run keeps reporting while you're on another screen.
  useRunEvents();
  return (
    <div className={styles.app}>
      <TitleBar />
      <div className={styles.body}>
        <NavRail />
        <main className={styles.content}>
          {route.view === "flows" ? <FlowsWorkbench /> : null}
          {route.view === "agent" ? <AgentView /> : null}
          {route.view === "cases" ? <CasesView /> : null}
          {route.view === "reports" ? <ReportsView /> : null}
        </main>
      </div>
      <RunOptionsDialog />
    </div>
  );
}
