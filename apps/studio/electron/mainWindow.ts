import type { BrowserWindow } from "electron";

// Side-effect-free holder so services can reach the window without importing
// main.ts (keeps the module graph acyclic and testable).
let mainWindow: BrowserWindow | null = null;

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
