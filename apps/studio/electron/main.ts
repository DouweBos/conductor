import { app, BrowserWindow, nativeTheme, shell } from "electron";
import path from "node:path";

import { registerIpcHandlers } from "./ipc";
import { installOpenProjectMenuItem } from "./menu";
import { startMcpServer, stopMcpServer } from "./services/mcp/server";
import { getMainWindow, setMainWindow } from "./mainWindow";
import { disposeAllDeviceStreams } from "./services/device/deviceService";
import { releaseAllReservations } from "./services/device/reservations";
import { stopAllRuns } from "./services/flow/flowRunner";
import { stopAllLogs } from "./services/logs/logsService";
import { initUpdater } from "./services/updater/updaterService";
import { fixProcessPath } from "./shellEnv";

const isDev = !app.isPackaged;
const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? `http://localhost:${process.env.STUDIO_PORT ?? 5273}`;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#14151c" : "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  // Renderer/GPU deaths are silent otherwise — the window just goes blank.
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error("[studio] renderer gone:", details.reason, details.exitCode);
  });

  // Open external links in the user's browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) {
    void win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    void win.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  setMainWindow(win);
  win.on("closed", () => setMainWindow(null));
}

// Single-instance lock — focus the existing window instead of opening another.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    await fixProcessPath();
    registerIpcHandlers();
    installOpenProjectMenuItem();
    // Agents reach the scene graph through this; a failure here must not stop
    // the app from launching.
    await startMcpServer().catch((err: unknown) => {
      console.error("[studio] MCP server failed to start:", err);
    });
    createWindow();
    if (!isDev) initUpdater();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("child-process-gone", (_e, details) => {
  console.error("[studio] child process gone:", details.type, details.reason, details.exitCode);
});

process.on("uncaughtException", (err) => console.error("[studio] uncaught exception:", err));
process.on("unhandledRejection", (err) => console.error("[studio] unhandled rejection:", err));

app.on("before-quit", () => {
  disposeAllDeviceStreams();
  stopAllLogs();
  stopAllRuns();
  stopMcpServer();
  // Quitting shouldn't leave a device claimed against a PID that's gone.
  void releaseAllReservations();
});
