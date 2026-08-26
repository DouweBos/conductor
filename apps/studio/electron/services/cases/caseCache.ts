import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { studioDir } from "../util/studioPaths";
import { codeOf, type Case } from "./model";

export { codeOf };
import { listCases as fetchCases, listCustomFields, listSuites } from "./qaseClient";
import { toCase } from "./qaseMapping";

/**
 * Cases as Qase has them, cached on disk.
 *
 * The cache is disposable: Qase owns every field, Studio writes none of them
 * back, and what a case is automated by lives in the flows themselves. Delete
 * it and the next refresh restores it in full.
 */

interface CachedProject {
  code: string;
  fetchedAt: number;
  cases: Case[];
}

function cacheDir(): string {
  return studioDir("qase-cache");
}

function cachePath(code: string): string {
  return path.join(cacheDir(), `${code.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json`);
}

export async function cached(code: string): Promise<CachedProject | null> {
  const file = cachePath(code);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, "utf8")) as CachedProject;
  } catch {
    // A truncated cache is not worth recovering — refetch instead.
    return null;
  }
}

/** Every project code with a cache, so the app knows what it can show offline. */
export async function cachedCodes(): Promise<string[]> {
  if (!existsSync(cacheDir())) return [];
  const codes: string[] = [];
  for (const file of (await readdir(cacheDir())).filter((f) => f.endsWith(".json"))) {
    const project = await cached(path.basename(file, ".json"));
    if (project) codes.push(project.code);
  }
  return codes.sort();
}

export async function refresh(code: string, token: string): Promise<CachedProject> {
  const [entities, suiteList, fieldList] = await Promise.all([
    fetchCases(code, token),
    listSuites(code, token).catch(() => []),
    listCustomFields(code, token).catch(() => []),
  ]);
  const suites = new Map(suiteList.map((s) => [s.id, s.title]));
  const fields = new Map(fieldList.map((f) => [f.id, f.title]));

  const project: CachedProject = {
    code: code.toUpperCase(),
    fetchedAt: Date.now(),
    cases: entities.map((entity) => toCase(entity, code.toUpperCase(), suites, fields)),
  };
  await mkdir(cacheDir(), { recursive: true });
  await writeFile(cachePath(code), JSON.stringify(project), "utf8");
  return project;
}

export async function forget(code: string): Promise<void> {
  await rm(cachePath(code), { force: true });
}
