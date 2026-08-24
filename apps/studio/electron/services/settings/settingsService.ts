import { app, safeStorage } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { EnvProfile, ThemePreference } from "../../../app/lib/types";
import { ALL_PROJECTS, DEFAULT_DATASOURCE, type CaseProject, type CasesDatasource } from "../cases/model";

interface Settings {
  theme: ThemePreference;
  updaterChannel: string;
  /** Project roots the user has opened, most-recent first. */
  recentProjects: string[];
  /** Saved run configurations, keyed by project root. */
  envProfiles: Record<string, EnvProfile[]>;
  /** Case sub-projects (mobile, tv, …), keyed by repo root. */
  caseProjects: Record<string, CaseProject[]>;
  /** Selected sub-project id, or `all`, keyed by repo root. */
  activeCaseProject: Record<string, string>;
  /** Qase API tokens, encrypted with safeStorage, keyed by repo root then sub-project. */
  qaseTokens: Record<string, Record<string, string>>;
}

/** The shape written before sub-projects existed — one datasource per repo. */
interface LegacySettings {
  casesDatasource?: Record<string, CasesDatasource>;
  qaseTokens?: Record<string, string | Record<string, string>>;
}

const DEFAULTS: Settings = {
  theme: "system",
  updaterChannel: "latest",
  recentProjects: [],
  envProfiles: {},
  caseProjects: {},
  activeCaseProject: {},
  qaseTokens: {},
};

/** Id of the sub-project a pre-sub-project install is folded into. */
export const LEGACY_PROJECT = "default";

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

function load(): Settings {
  try {
    const raw = readFileSync(settingsPath(), "utf8");
    return migrate({ ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) });
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Fold a pre-sub-project settings file forward: the single datasource becomes
 * one sub-project called `default`, and its token moves under that id. The
 * on-disk cases and plans are moved to match by `caseProjectDir()`.
 */
function migrate(settings: Settings & LegacySettings): Settings {
  const legacyDatasources = settings.casesDatasource ?? {};
  for (const [root, datasource] of Object.entries(legacyDatasources)) {
    if (settings.caseProjects[root]?.length) continue;
    settings.caseProjects[root] = [
      { id: LEGACY_PROJECT, name: datasource.projectCode || "Cases", datasource },
    ];
  }
  for (const [root, stored] of Object.entries(settings.qaseTokens)) {
    if (typeof stored === "string") settings.qaseTokens[root] = { [LEGACY_PROJECT]: stored };
  }
  delete settings.casesDatasource;
  return settings;
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

// ── Case sub-projects ───────────────────────────────────────────────────────

/**
 * Sub-projects for a repo. A repo that has never been configured gets one
 * implicit local project, so the Cases screen always has somewhere to write.
 */
export function getCaseProjects(root: string): CaseProject[] {
  const stored = load().caseProjects[root];
  if (stored?.length) return stored.map((p) => withToken(root, p));
  return [{ id: LEGACY_PROJECT, name: "Cases", datasource: { ...DEFAULT_DATASOURCE } }];
}

/** `hasToken` is derived; storing it would let it drift from the actual token. */
function withToken(root: string, project: CaseProject): CaseProject {
  return {
    ...project,
    datasource: {
      ...project.datasource,
      hasToken: Boolean(process.env.QASE_API_TOKEN || load().qaseTokens[root]?.[project.id]),
    },
  };
}

export function saveCaseProject(root: string, project: CaseProject): CaseProject {
  const settings = load();
  const projects = settings.caseProjects[root] ?? getCaseProjects(root);
  const { hasToken: _ignored, ...datasource } = project.datasource;
  const persisted = { ...project, datasource };
  const index = projects.findIndex((p) => p.id === project.id);
  settings.caseProjects[root] = index >= 0
    ? projects.map((p, i) => (i === index ? persisted : p))
    : [...projects, persisted];
  save(settings);
  return withToken(root, persisted);
}

/** Removing a sub-project takes its token with it; its cases stay on disk. */
export function deleteCaseProject(root: string, id: string): CaseProject[] {
  const settings = load();
  const projects = (settings.caseProjects[root] ?? getCaseProjects(root)).filter((p) => p.id !== id);
  settings.caseProjects[root] = projects;
  if (settings.qaseTokens[root]) delete settings.qaseTokens[root][id];
  if (settings.activeCaseProject[root] === id) delete settings.activeCaseProject[root];
  save(settings);
  return getCaseProjects(root);
}

/** The selection, which is `all` or a sub-project that still exists. */
export function getActiveCaseProject(root: string): string {
  const stored = load().activeCaseProject[root];
  if (stored === ALL_PROJECTS) return stored;
  const projects = getCaseProjects(root);
  return projects.some((p) => p.id === stored) ? stored : projects[0].id;
}

export function setActiveCaseProject(root: string, id: string): void {
  const settings = load();
  settings.activeCaseProject[root] = id;
  save(settings);
}

/**
 * The Qase token, encrypted at rest. `QASE_API_TOKEN` wins when set, so a
 * developer can point at another Qase project without touching stored state.
 */
export function getQaseToken(root: string, projectId: string): string | undefined {
  const fromEnv = process.env.QASE_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const stored = load().qaseTokens[root]?.[projectId];
  if (!stored) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(stored, "base64"));
  } catch {
    return undefined;
  }
}

export function setQaseToken(root: string, projectId: string, token: string | null): void {
  const settings = load();
  const tokens = settings.qaseTokens[root] ?? {};
  if (!token) delete tokens[projectId];
  else if (safeStorage.isEncryptionAvailable()) {
    tokens[projectId] = safeStorage.encryptString(token).toString("base64");
  } else {
    throw new Error("Encrypted storage is unavailable, so the Qase token cannot be saved.");
  }
  settings.qaseTokens[root] = tokens;
  save(settings);
}
