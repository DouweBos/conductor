import { useSyncExternalStore } from "react";

// URL is the single source of truth for "which screen". We use the hash so it
// works under Electron's file:// in production. No Zustand slice mirrors this.
//
// Route inventory:
//   #/flows                 → Maestro workbench (no file open)
//   #/flows/<path>          → workbench with a flow open (path is flows-relative)
//   #/agent                 → agentic writer
//   #/cases                 → test case management

export type View = "flows" | "agent" | "cases";

export interface ParsedRoute {
  view: View;
  flowPath?: string;
}

export function parseRoute(hash: string): ParsedRoute {
  const path = hash.replace(/^#/, "") || "/flows";
  const segments = path.split("/").filter(Boolean);
  const view = (segments[0] as View) || "flows";
  if (view === "flows") {
    const flowPath = segments.length > 1
      ? decodeURIComponent(segments.slice(1).join("/"))
      : undefined;
    return { view: "flows", flowPath };
  }
  if (view === "agent" || view === "cases") return { view };
  return { view: "flows" };
}

export function routeToPath(route: ParsedRoute): string {
  if (route.view === "flows" && route.flowPath) {
    return `/flows/${route.flowPath.split("/").map(encodeURIComponent).join("/")}`;
  }
  return `/${route.view}`;
}

export function appNavigate(route: ParsedRoute): void {
  const next = `#${routeToPath(route)}`;
  if (window.location.hash !== next) window.location.hash = next;
}

// ── Semantic wrappers ──
export function setView(view: View): void {
  appNavigate({ view });
}

export function selectFlow(flowPath: string): void {
  appNavigate({ view: "flows", flowPath });
}

// ── Reactive reads ──
function subscribe(callback: () => void): () => void {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

function getSnapshot(): string {
  return window.location.hash;
}

export function useRoute(): ParsedRoute {
  const hash = useSyncExternalStore(subscribe, getSnapshot);
  return parseRoute(hash);
}

export function getCurrentRoute(): ParsedRoute {
  return parseRoute(window.location.hash);
}
