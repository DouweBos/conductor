import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { initProject } from "./stores/projectStore";
import { initTheme } from "./stores/themeStore";
import "./styles/global.css";

void initTheme();
void initProject();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
