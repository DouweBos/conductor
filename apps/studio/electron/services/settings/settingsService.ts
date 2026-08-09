import { app } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ThemePreference } from "../../../app/lib/types";

interface Settings {
  theme: ThemePreference;
  updaterChannel: string;
  /** Last project root the user opened, reopened on the next launch. */
  projectRoot: string | null;
}

const DEFAULTS: Settings = { theme: "system", updaterChannel: "latest", projectRoot: null };

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

function load(): Settings {
  try {
    const raw = readFileSync(settingsPath(), "utf8");
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(settings: Settings): void {
  try {
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), "utf8");
  } catch {
    // best-effort; a failed write shouldn't crash the app
  }
}

export function getTheme(): ThemePreference {
  return load().theme;
}

export function setTheme(theme: ThemePreference): void {
  save({ ...load(), theme });
}

export function getUpdaterChannel(): string {
  return load().updaterChannel;
}

export function getSavedProjectRoot(): string | null {
  return load().projectRoot;
}

export function setSavedProjectRoot(projectRoot: string | null): void {
  save({ ...load(), projectRoot });
}
