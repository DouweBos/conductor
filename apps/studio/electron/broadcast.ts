import { BrowserWindow } from "electron";

// Push an event to every live renderer window. All backend → renderer streams
// (device frames, flow-run output, updater state) go through here.
export function broadcastToRenderers(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}
