import { app } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { RunArtifacts, RunRecord } from "../../../app/lib/types";
import { appState } from "../../state";
import { findRunDir, readArtifacts } from "./artifacts";

/**
 * What happened the last time you ran something. Runs used to live only in an
 * in-memory map and scroll out of the console, so "it passed ten minutes ago"
 * was unanswerable. Records are per project, kept in app data (machine-local
 * noise, not something to commit).
 */

const LIMIT = 200;

function historyPath(): string {
  return path.join(app.getPath("userData"), "run-history.json");
}

type Store = Record<string, RunRecord[]>;

function load(): Store {
  try {
    if (!existsSync(historyPath())) return {};
    return JSON.parse(readFileSync(historyPath(), "utf8")) as Store;
  } catch {
    return {};
  }
}

function save(store: Store): void {
  try {
    writeFileSync(historyPath(), JSON.stringify(store, null, 2), "utf8");
  } catch {
    // History is a convenience; never fail a run over it.
  }
}

function key(): string {
  return appState.projectRoot ?? "(no project)";
}

export function listHistory(): RunRecord[] {
  return load()[key()] ?? [];
}

export function recordRun(record: RunRecord): void {
  const store = load();
  const project = key();
  store[project] = [record, ...(store[project] ?? [])].slice(0, LIMIT);
  save(store);
}

export function clearHistory(): void {
  const store = load();
  delete store[key()];
  save(store);
}

/** Maestro's debug output for a past run, read on demand. */
export function historyArtifacts(runId: string): RunArtifacts | null {
  const record = listHistory().find((r) => r.runId === runId);
  return record?.artifactDir ? readArtifacts(record.artifactDir) : null;
}

/** The debug directory maestro wrote for a run that started at `startedAt`. */
export function artifactDirFor(startedAt: number): string | undefined {
  return findRunDir(startedAt) ?? undefined;
}
