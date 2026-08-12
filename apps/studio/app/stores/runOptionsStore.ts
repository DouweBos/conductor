import { create } from "zustand";

import { deleteEnvProfile, envProfiles, saveEnvProfile } from "../lib/ipc";
import type { EnvProfile, RunOptions } from "../lib/types";

/**
 * Run options — env variables, tags, and the profile they came from — are a
 * property of the session, not of the flow that happens to be open: a case run,
 * a folder run and a single flow all need the same `APP_ID`. They live here so
 * every runner reads one set, and closing the last tab doesn't drop them.
 */

export interface EnvRow {
  key: string;
  value: string;
}

interface RunOptionsState {
  envRows: EnvRow[];
  includeTags: string;
  excludeTags: string;
  profiles: EnvProfile[];
  /** Name of the profile the options came from, "" once they're detached. */
  activeProfile: string;
  dialogOpen: boolean;
}

const STORAGE_KEY = "conductor-studio.run-options";

function restore(): Pick<RunOptionsState, "envRows" | "includeTags" | "excludeTags" | "activeProfile"> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { envRows: [], includeTags: "", excludeTags: "", activeProfile: "", ...JSON.parse(raw) };
  } catch {
    // A malformed blob just means "no saved options".
  }
  return { envRows: [], includeTags: "", excludeTags: "", activeProfile: "" };
}

const store = create<RunOptionsState>(() => ({
  ...restore(),
  profiles: [],
  dialogOpen: false,
}));

store.subscribe((s) => {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        envRows: s.envRows,
        includeTags: s.includeTags,
        excludeTags: s.excludeTags,
        activeProfile: s.activeProfile,
      }),
    );
  } catch {
    // Persistence is a convenience; never break a run over it.
  }
});

export const useEnvRows = () => store((s) => s.envRows);
export const useIncludeTags = () => store((s) => s.includeTags);
export const useExcludeTags = () => store((s) => s.excludeTags);
export const useProfiles = () => store((s) => s.profiles);
export const useActiveProfile = () => store((s) => s.activeProfile);
export const useRunOptionsOpen = () => store((s) => s.dialogOpen);

/** What every runner passes to the backend. */
export function getRunOptions(): RunOptions {
  const { envRows, includeTags, excludeTags } = store.getState();
  const env: Record<string, string> = {};
  for (const row of envRows) if (row.key.trim()) env[row.key.trim()] = row.value;
  return {
    env: Object.keys(env).length ? env : undefined,
    includeTags: includeTags.trim() || undefined,
    excludeTags: excludeTags.trim() || undefined,
  };
}

/** True when a run would carry something — the toolbar flags it, so an unset `${VAR}` isn't a mystery. */
export const useHasRunOptions = () =>
  store((s) => Boolean(s.envRows.some((r) => r.key.trim()) || s.includeTags.trim() || s.excludeTags.trim()));

export function setEnvRows(update: EnvRow[] | ((rows: EnvRow[]) => EnvRow[])): void {
  store.setState((s) => ({
    envRows: typeof update === "function" ? update(s.envRows) : update,
  }));
}

export function setIncludeTags(includeTags: string): void {
  store.setState({ includeTags });
}

export function setExcludeTags(excludeTags: string): void {
  store.setState({ excludeTags });
}

export function openRunOptions(): void {
  store.setState({ dialogOpen: true });
}

export function closeRunOptions(): void {
  store.setState({ dialogOpen: false });
}

export async function refreshProfiles(): Promise<void> {
  try {
    const profiles = await envProfiles();
    // Profiles are per project, so a restored name the project doesn't have
    // means "these options are just custom now".
    store.setState((s) => ({
      profiles,
      activeProfile: profiles.some((p) => p.name === s.activeProfile) ? s.activeProfile : "",
    }));
  } catch {
    store.setState({ profiles: [] });
  }
}

export function applyProfile(profile: EnvProfile): void {
  store.setState({
    envRows: Object.entries(profile.env).map(([key, value]) => ({ key, value })),
    includeTags: profile.includeTags ?? "",
    excludeTags: profile.excludeTags ?? "",
    activeProfile: profile.name,
  });
}

export function clearProfile(): void {
  store.setState({ activeProfile: "" });
}

export async function storeProfile(name: string): Promise<void> {
  if (!name) return;
  const { env = {}, includeTags, excludeTags } = getRunOptions();
  const profiles = await saveEnvProfile({ name, env, includeTags, excludeTags });
  store.setState({ profiles, activeProfile: name });
}

export async function removeActiveProfile(): Promise<void> {
  const { activeProfile } = store.getState();
  if (!activeProfile) return;
  store.setState({ profiles: await deleteEnvProfile(activeProfile), activeProfile: "" });
}
