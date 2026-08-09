import electronUpdater from "electron-updater";

import type { UpdaterState } from "../../../app/lib/types";
import { broadcastToRenderers } from "../../broadcast";
import { getUpdaterChannel } from "../settings/settingsService";

const { autoUpdater } = electronUpdater;

let state: UpdaterState = { phase: "idle" };
let initialized = false;

function setState(next: Partial<UpdaterState>): void {
  state = { ...state, ...next };
  broadcastToRenderers("updater:state", state);
}

export function getUpdaterState(): UpdaterState {
  return state;
}

export function initUpdater(): void {
  if (initialized) return;
  initialized = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  try {
    autoUpdater.channel = getUpdaterChannel();
  } catch {
    // channel unsupported by provider; ignore
  }

  autoUpdater.on("checking-for-update", () => setState({ phase: "checking", error: undefined }));
  autoUpdater.on("update-available", (info) =>
    setState({ phase: "available", version: info.version }),
  );
  autoUpdater.on("update-not-available", () => setState({ phase: "not-available" }));
  autoUpdater.on("download-progress", (p) =>
    setState({ phase: "downloading", progress: Math.round(p.percent) }),
  );
  autoUpdater.on("update-downloaded", (info) =>
    setState({ phase: "downloaded", version: info.version, progress: 100 }),
  );
  autoUpdater.on("error", (err) =>
    setState({ phase: "error", error: friendlyError(err) }),
  );

  // Initial check shortly after startup, then hourly.
  setTimeout(() => void checkForUpdates(), 5_000);
  setInterval(() => void checkForUpdates(), 60 * 60 * 1000);
}

export async function checkForUpdates(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    setState({ phase: "error", error: friendlyError(err) });
  }
}

export async function downloadUpdate(): Promise<void> {
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    setState({ phase: "error", error: friendlyError(err) });
  }
}

export function quitAndInstallUpdate(): void {
  autoUpdater.quitAndInstall(false, true);
}

function friendlyError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/404/.test(message)) return "No published release found for this channel yet.";
  if (/(net::|ENOTFOUND|ETIMEDOUT)/.test(message)) return "Couldn't reach the update server.";
  return message;
}
