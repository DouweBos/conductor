import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import type { CaseMatrix, TestCase } from "../../../app/lib/types";
import { getProjectInfo } from "../file/fileService";

const CASES_DIR = "test-cases";
const DEFAULT_DIMENSION = "platform";

function casesRoot(): string {
  const project = getProjectInfo();
  if (!project) throw new Error("No project is open.");
  return path.join(project.root, CASES_DIR);
}

export async function listCases(): Promise<TestCase[]> {
  const root = casesRoot();
  if (!existsSync(root)) return [];
  const project = getProjectInfo()!;
  const files = (await readdir(root)).filter((f) => /\.(ya?ml)$/i.test(f));
  const cases: TestCase[] = [];
  for (const file of files) {
    const abs = path.join(root, file);
    try {
      const raw = parseYaml(await readFile(abs, "utf8")) as Record<string, unknown>;
      const parsed = normalizeCase(raw, path.relative(project.root, abs));
      if (parsed) cases.push(parsed);
    } catch {
      // skip malformed case files
    }
  }
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeCase(raw: Record<string, unknown>, filePath: string): TestCase | null {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id ?? "").trim();
  const title = String(raw.title ?? "").trim();
  if (!id || !title) return null;

  const tags: Record<string, string[]> = {};
  if (raw.tags && typeof raw.tags === "object") {
    for (const [dim, value] of Object.entries(raw.tags as Record<string, unknown>)) {
      tags[dim] = Array.isArray(value) ? value.map(String) : [String(value)];
    }
  }
  return {
    id,
    title,
    description: raw.description ? String(raw.description) : undefined,
    userStory: raw.userStory ? String(raw.userStory) : undefined,
    tags,
    flow: raw.flow ? String(raw.flow) : undefined,
    ciStatus: undefined, // GH Actions sync is a follow-on
    filePath,
  };
}

export async function buildMatrix(dimension = DEFAULT_DIMENSION): Promise<CaseMatrix> {
  const cases = await listCases();
  const columns = [
    ...new Set(cases.flatMap((c) => c.tags[dimension] ?? [])),
  ].sort();
  return { dimension, columns, cases };
}
