import { app, safeStorage } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { EnvProfile, ThemePreference } from "../../../app/lib/types";
import { DEFAULT_DATASOURCE, type CasesDatasource } from "../cases/model";

interface Settings {
  theme: ThemePreference;
  updaterChannel: string;
  /** Project roots the user has opened, most-recent first. */
  recentProjects: string[];
  /** Saved run configurations, keyed by project root. */
  envProfiles: Record<string, EnvProfile[]>;
  /** Where each project's test cases come from, keyed by project root. */
  casesDatasource: Record<string, CasesDatasource>;
  /** Qase API tokens, encrypted with safeStorage, keyed by project root. */
  qaseTokens: Record<string, string>;
}

const DEFAULTS: Settings = {
  theme: "system",
  updaterChannel: "latest",
  recentProjects: [],
  envProfiles: {},
  casesDatasource: {},
  qaseTokens: {},
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

// ── Test case datasource ────────────────────────────────────────────────────

export function getCasesDatasource(root: string): CasesDatasource {
  const settings = load();
  const stored = settings.casesDatasource[root];
  return {
    ...DEFAULT_DATASOURCE,
    ...stored,
    hasToken: Boolean(process.env.QASE_API_TOKEN || settings.qaseTokens[root]),
  };
}

export function setCasesDatasource(root: string, datasource: CasesDatasource): CasesDatasource {
  const settings = load();
  // hasToken is derived; storing it would let it drift from the actual token.
  const { hasToken: _ignored, ...persisted } = datasource;
  settings.casesDatasource[root] = persisted;
  save(settings);
  return getCasesDatasource(root);
}

/**
 * The Qase token, encrypted at rest. `QASE_API_TOKEN` wins when set, so a
 * developer can point at another Qase project without touching stored state.
 */
export function getQaseToken(root: string): string | undefined {
  const fromEnv = process.env.QASE_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const stored = load().qaseTokens[root];
  if (!stored) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(stored, "base64"));
  } catch {
    return undefined;
  }
}

export function setQaseToken(root: string, token: string | null): void {
  const settings = load();
  if (!token) delete settings.qaseTokens[root];
  else if (safeStorage.isEncryptionAvailable()) {
    settings.qaseTokens[root] = safeStorage.encryptString(token).toString("base64");
  } else {
    throw new Error("Encrypted storage is unavailable, so the Qase token cannot be saved.");
  }
  save(settings);
}
