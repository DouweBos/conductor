import { AgentView } from "./components/agent/AgentView";
import { CasesView } from "./components/cases/CasesView";
import { FlowsWorkbench } from "./components/flows/FlowsWorkbench";
import { NavRail } from "./components/layout/NavRail";
import { TitleBar } from "./components/layout/TitleBar";
import { useRoute } from "./lib/router";
import styles from "./App.module.css";

export function App() {
  const route = useRoute();
  return (
    <div className={styles.app}>
      <TitleBar />
      <div className={styles.body}>
        <NavRail />
        <main className={styles.content}>
          {route.view === "flows" ? <FlowsWorkbench /> : null}
          {route.view === "agent" ? <AgentView /> : null}
          {route.view === "cases" ? <CasesView /> : null}
        </main>
      </div>
    </div>
  );
}
