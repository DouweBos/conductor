import { app, safeStorage } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { EnvProfile, ThemePreference } from "../../../app/lib/types";
import type { QaseProject } from "../cases/model";

interface Settings {
  theme: ThemePreference;
  updaterChannel: string;
  /** Project roots the user has opened, most-recent first. */
  recentProjects: string[];
  /** Saved run configurations, keyed by project root. */
  envProfiles: Record<string, EnvProfile[]>;
  /** Qase projects a repo reads cases from, keyed by repo root. */
  qaseProjects: Record<string, QaseProject[]>;
  /** Qase API tokens, encrypted with safeStorage, keyed by repo root then project code. */
  qaseTokens: Record<string, Record<string, string>>;
}

const DEFAULTS: Settings = {
  theme: "system",
  updaterChannel: "latest",
  recentProjects: [],
  envProfiles: {},
  qaseProjects: {},
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

// ── Qase projects ───────────────────────────────────────────────────────────

export function getQaseProjects(root: string): QaseProject[] {
  return (load().qaseProjects[root] ?? []).map((project) => withToken(root, project));
}

/** `hasToken` is derived; storing it would let it drift from the actual token. */
function withToken(root: string, project: QaseProject): QaseProject {
  return {
    ...project,
    hasToken: Boolean(process.env.QASE_API_TOKEN || load().qaseTokens[root]?.[project.code]),
  };
}

export function saveQaseProject(root: string, project: QaseProject): QaseProject[] {
  const settings = load();
  const code = project.code.trim().toUpperCase();
  const { hasToken: _ignored, ...persisted } = { ...project, code };
  const projects = settings.qaseProjects[root] ?? [];
  const index = projects.findIndex((p) => p.code === code);
  settings.qaseProjects[root] =
    index >= 0 ? projects.map((p, i) => (i === index ? persisted : p)) : [...projects, persisted];
  save(settings);
  return getQaseProjects(root);
}

/** Removing a project takes its token with it; its cache is dropped separately. */
export function deleteQaseProject(root: string, code: string): QaseProject[] {
  const settings = load();
  settings.qaseProjects[root] = (settings.qaseProjects[root] ?? []).filter((p) => p.code !== code);
  if (settings.qaseTokens[root]) delete settings.qaseTokens[root][code];
  save(settings);
  return getQaseProjects(root);
}

/**
 * The Qase token for one project, encrypted at rest. `QASE_API_TOKEN` wins when
 * set, so a developer can point at another Qase project without touching
 * stored state.
 */
export function getQaseToken(root: string, code: string): string | undefined {
  const fromEnv = process.env.QASE_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const stored = load().qaseTokens[root]?.[code.toUpperCase()];
  if (!stored) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(stored, "base64"));
  } catch {
    return undefined;
  }
}

export function setQaseToken(root: string, code: string, token: string | null): void {
  const settings = load();
  const tokens = settings.qaseTokens[root] ?? {};
  const key = code.toUpperCase();
  if (!token) delete tokens[key];
  else if (safeStorage.isEncryptionAvailable()) {
    tokens[key] = safeStorage.encryptString(token).toString("base64");
  } else {
    throw new Error("Encrypted storage is unavailable, so the Qase token cannot be saved.");
  }
  settings.qaseTokens[root] = tokens;
  save(settings);
}
