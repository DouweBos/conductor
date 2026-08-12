import { Menu, MenuItem } from "electron";

import { broadcastToRenderers } from "./broadcast";
import { pickProject } from "./services/file/fileService";

// Keep Electron's default menu (edit/window/help) and just add File → Open
// Project…, so ⌘O works like every other editor.
export function installOpenProjectMenuItem(): void {
  const menu = Menu.getApplicationMenu();
  const file = menu?.items.find((item) => item.label === "File");
  if (!file?.submenu) return;

  file.submenu.insert(
    0,
    new MenuItem({
      label: "Open Project…",
      accelerator: "CmdOrCtrl+O",
      click: () => {
        void pickProject().then((project) => {
          if (project) broadcastToRenderers("project:opened", project);
        });
      },
    }),
  );
  file.submenu.insert(1, new MenuItem({ type: "separator" }));
  Menu.setApplicationMenu(menu);
}
