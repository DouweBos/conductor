import { app } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { EnvProfile, ThemePreference } from "../../../app/lib/types";

interface Settings {
  theme: ThemePreference;
  updaterChannel: string;
  /** Project roots the user has opened, most-recent first. */
  recentProjects: string[];
  /** Saved run configurations, keyed by project root. */
  envProfiles: Record<string, EnvProfile[]>;
}

const DEFAULTS: Settings = {
  theme: "system",
  updaterChannel: "latest",
  recentProjects: [],
  envProfiles: {},
};

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

const MAX_RECENTS = 8;

export function getRecentProjects(): string[] {
  return load().recentProjects;
}

export function addRecentProject(root: string): void {
  const settings = load();
  const recentProjects = [root, ...settings.recentProjects.filter((p) => p !== root)].slice(
    0,
    MAX_RECENTS,
  );
  save({ ...settings, recentProjects });
}

/**
 * Saved run configurations. Every flow in a suite like Plex's needs APP_ID and
 * a platform, so retyping them per session is pure friction.
 */
export function getEnvProfiles(root: string): EnvProfile[] {
  return load().envProfiles[root] ?? [];
}

export function saveEnvProfile(root: string, profile: EnvProfile): EnvProfile[] {
  const settings = load();
  const existing = (settings.envProfiles[root] ?? []).filter((p) => p.name !== profile.name);
  settings.envProfiles[root] = [...existing, profile].sort((a, b) => a.name.localeCompare(b.name));
  save(settings);
  return settings.envProfiles[root];
}

export function deleteEnvProfile(root: string, name: string): EnvProfile[] {
  const settings = load();
  settings.envProfiles[root] = (settings.envProfiles[root] ?? []).filter((p) => p.name !== name);
  save(settings);
  return settings.envProfiles[root];
}
