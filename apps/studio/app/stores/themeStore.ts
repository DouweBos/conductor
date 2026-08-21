import { create } from "zustand";

import { getTheme, setTheme as persistTheme } from "../lib/ipc";
import type { ThemePreference } from "../lib/types";

interface ThemeState {
  preference: ThemePreference;
  /** The concrete theme currently applied to <html data-theme>. */
  resolved: "light" | "dark";
}

const store = create<ThemeState>(() => ({ preference: "system", resolved: "light" }));

export const useThemeStore = store;
export const useThemePreference = () => store((s) => s.preference);
export const useResolvedTheme = () => store((s) => s.resolved);

function systemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function apply(preference: ThemePreference): void {
  const resolved: "light" | "dark" =
    preference === "system" ? (systemPrefersDark() ? "dark" : "light") : preference;
  document.documentElement.setAttribute("data-theme", resolved);
  store.setState({ preference, resolved });
}

export async function initTheme(): Promise<void> {
  let preference: ThemePreference = "system";
  try {
    preference = await getTheme();
  } catch {
    // keep default
  }
  apply(preference);
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (store.getState().preference === "system") apply("system");
  });
}

export function setThemePreference(preference: ThemePreference): void {
  apply(preference);
  void persistTheme(preference);
}

export function toggleTheme(): void {
  const current = store.getState().resolved;
  setThemePreference(current === "dark" ? "light" : "dark");
}
