/**
 * Pulling cases from Qase into the local store.
 *
 * Qase owns case content and wins on every pull. The `conductor` block is the
 * exception: it's the automation wiring Qase knows nothing about, so it is read
 * off the existing file and re-attached, and anything that couldn't be
 * re-attached is reported rather than silently dropped.
 *
 * Electron-free by design so it stays testable as plain Node.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { Document, parseDocument, parse as parseYaml } from "yaml";

import { fileNameFor, parseCase, writeCase } from "./caseFile";
import {
  BEHAVIORS,
  CASE_STATUSES,
  CASE_TYPES,
  PRIORITIES,
  SEVERITIES,
  decodeEnum,
  type Case,
  type CaseStep,
  type PullSummary,
} from "./model";
import { listCases, listCustomFields, listSuites, type QaseCase } from "./qaseClient";

export interface PullOptions {
  casesDir: string;
  projectCode: string;
  token: string;
  suiteIds?: number[];
}

interface Existing {
  filePath: string;
  parsed: Case;
}

async function readExisting(dir: string, projectCode: string): Promise<Map<number, Existing>> {
  const byId = new Map<number, Existing>();
  if (!existsSync(dir)) return byId;
  for (const file of (await readdir(dir)).filter((f) => /\.ya?ml$/i.test(f))) {
    const filePath = path.join(dir, file);
    try {
      const raw = parseYaml(await readFile(filePath, "utf8")) as Record<string, unknown>;
      const parsed = parseCase(raw, filePath, projectCode);
      if (parsed) byId.set(parsed.id, { filePath, parsed });
    } catch {
      // A malformed file can't own an id; the pull will write a fresh one.
    }
  }
  return byId;
}

/**
 * Re-attach a step's page object across a pull. Qase's per-step `hash` is
 * stable across edits, so prefer it; fall back to the action text, then to
 * position — which is the case that can genuinely mis-attach, hence the report.
 */
function reattachPoms(
  next: CaseStep[],
  previous: CaseStep[],
): { steps: CaseStep[]; lost: { action: string; pom: string }[] } {
  const claimed = new Set<number>();
  const take = (predicate: (s: CaseStep, i: number) => boolean): CaseStep | undefined => {
    const index = previous.findIndex((s, i) => !claimed.has(i) && predicate(s, i));
    if (index < 0) return undefined;
    claimed.add(index);
    return previous[index];
  };

  const steps = next.map((step, index) => {
    const match =
      (step.hash ? take((s) => Boolean(s.hash) && s.hash === step.hash) : undefined) ??
      take((s) => s.action === step.action) ??
      take((_, i) => i === index);
    return match?.pom || match?.env ? { ...step, pom: match.pom, env: match.env } : step;
  });

  const lost = previous
    .map((step, index) => ({ step, index }))
    .filter(({ step, index }) => step.pom && !claimed.has(index))
    .map(({ step }) => ({ action: step.action, pom: step.pom as string }));

  return { steps, lost };
}

function toCase(
  entity: QaseCase,
  projectCode: string,
  suites: Map<number, string>,
  fields: Map<number, string>,
  filePath: string,
): Case {
  const custom_fields: Record<string, string[]> = {};
  for (const field of entity.custom_fields ?? []) {
    const title = fields.get(field.id);
    if (!title) continue;
    // Multi-selects come back as a comma-joined string.
    const values = String(field.value ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (values.length) custom_fields[title] = values;
  }

  const external = (entity.external_issues ?? [])
    .map((issue) => issue.link ?? issue.id)
    .filter((v): v is string => Boolean(v));

  return {
    id: entity.id,
    ref: `${projectCode}-${entity.id}`,
    title: entity.title,
    description: entity.description ?? undefined,
    preconditions: entity.preconditions ?? undefined,
    postconditions: entity.postconditions ?? undefined,
    severity: decodeEnum(SEVERITIES, entity.severity),
    priority: decodeEnum(PRIORITIES, entity.priority),
    type: decodeEnum(CASE_TYPES, entity.type),
    behavior: decodeEnum(BEHAVIORS, entity.behavior),
    status: decodeEnum(CASE_STATUSES, entity.status) ?? "actual",
    is_manual: entity.is_manual ?? entity.isManual ?? true,
    suite_id: entity.suite_id ?? undefined,
    suite: entity.suite_id ? suites.get(entity.suite_id) : undefined,
    milestone_id: entity.milestone_id ?? undefined,
    steps_type: entity.steps_type === "gherkin" ? "gherkin" : "classic",
    steps: (entity.steps ?? [])
      .filter((s) => s.action?.trim())
      .map((s) => ({
        hash: s.hash,
        action: (s.action as string).trim(),
        data: s.data ?? undefined,
        expected_result: s.expected_result ?? undefined,
      })),
    custom_fields,
    tags: (entity.tags ?? []).map((t) => t.title).filter(Boolean),
    external_issues: external.length ? external : undefined,
    author_id: entity.author_id,
    created_at: entity.created_at,
    updated_at: entity.updated_at,
    filePath,
  };
}

export async function pullCases(opts: PullOptions): Promise<PullSummary> {
  const { casesDir, projectCode, token, suiteIds } = opts;
  const summary: PullSummary = {
    pulled: 0,
    created: 0,
    updated: 0,
    deprecated: [],
    lostPoms: [],
    errors: [],
  };

  const [entities, suiteList, fieldList] = await Promise.all([
    listCases(projectCode, token, suiteIds),
    listSuites(projectCode, token).catch(() => []),
    listCustomFields(projectCode, token).catch(() => []),
  ]);
  const suites = new Map(suiteList.map((s) => [s.id, s.title]));
  const fields = new Map(fieldList.map((f) => [f.id, f.title]));

  await mkdir(casesDir, { recursive: true });
  const existing = await readExisting(casesDir, projectCode);
  const seen = new Set<number>();

  for (const entity of entities) {
    seen.add(entity.id);
    const prior = existing.get(entity.id);
    const target = path.join(casesDir, fileNameFor(`${projectCode}-${entity.id}`, entity.title));
    const next = toCase(entity, projectCode, suites, fields, prior?.filePath ?? target);

    if (prior) {
      next.conductor = prior.parsed.conductor;
      const { steps, lost } = reattachPoms(next.steps ?? [], prior.parsed.steps ?? []);
      next.steps = steps;
      summary.lostPoms.push(...lost.map((l) => ({ ref: next.ref, ...l })));
    }

    try {
      const doc = prior
        ? parseDocument(await readFile(prior.filePath, "utf8"))
        : new Document({});
      writeCase(doc, next);
      await writeFile(prior?.filePath ?? target, doc.toString({ lineWidth: 0 }), "utf8");
      // Keep the filename in step with the title it now carries.
      if (prior && path.resolve(prior.filePath) !== path.resolve(target)) {
        await rename(prior.filePath, target);
      }
      summary.pulled++;
      if (prior) summary.updated++;
      else summary.created++;
    } catch (error) {
      summary.errors.push(`${next.ref}: ${(error as Error).message}`);
    }
  }

  // Cases Qase no longer returns are marked, never deleted — deleting one takes
  // its flow link with it.
  for (const [id, entry] of existing) {
    if (seen.has(id) || entry.parsed.status === "deprecated") continue;
    try {
      const doc = parseDocument(await readFile(entry.filePath, "utf8"));
      writeCase(doc, { ...entry.parsed, status: "deprecated" });
      await writeFile(entry.filePath, doc.toString({ lineWidth: 0 }), "utf8");
      summary.deprecated.push(entry.parsed.ref);
    } catch (error) {
      summary.errors.push(`${entry.parsed.ref}: ${(error as Error).message}`);
    }
  }

  return summary;
}
