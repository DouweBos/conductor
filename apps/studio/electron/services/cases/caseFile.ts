/**
 * Reading and writing a case file: a Qase case entity as YAML, plus the
 * `conductor` block. Writes go through yaml's Document API so comments and key
 * order in a hand-edited file survive a round trip.
 */

import { Document, isMap, isSeq } from "yaml";

import {
  BEHAVIORS,
  CASE_STATUSES,
  CASE_TYPES,
  PRIORITIES,
  SEVERITIES,
  decodeEnum,
  type Case,
  type CaseStep,
  type ConductorBlock,
} from "./model";

function str(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function strList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((v) => v.trim()).filter(Boolean);
  const single = str(value);
  return single ? [single] : [];
}

function num(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Steps carry Qase's action/data/expected_result plus Conductor's pom/env. The
 * two live in separate blocks in the file and are merged positionally here, so
 * everything downstream sees one step with everything on it.
 */
function parseSteps(raw: unknown, automation: unknown): CaseStep[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const autos = Array.isArray(automation) ? automation : [];
  const steps: CaseStep[] = [];
  raw.forEach((item, index) => {
    const row: Record<string, unknown> =
      typeof item === "string" ? { action: item } : ((item ?? {}) as Record<string, unknown>);
    const action = str(row.action);
    if (!action) return;
    const auto = (autos[index] ?? {}) as Record<string, unknown>;
    const env: Record<string, string> = {};
    if (auto.env && typeof auto.env === "object") {
      for (const [k, v] of Object.entries(auto.env as Record<string, unknown>)) env[k] = String(v);
    }
    steps.push({
      hash: str(row.hash),
      action,
      data: str(row.data),
      expected_result: str(row.expected_result),
      pom: str(auto.pom),
      env: Object.keys(env).length ? env : undefined,
    });
  });
  return steps.length ? steps : undefined;
}

function parseCustomFields(raw: unknown): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  if (!raw || typeof raw !== "object") return fields;
  for (const [title, value] of Object.entries(raw as Record<string, unknown>)) {
    const values = strList(value);
    if (values.length) fields[title] = values;
  }
  return fields;
}

function parseConductor(raw: unknown): ConductorBlock | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Record<string, unknown>;
  const flows: Record<string, string> = {};
  if (row.flows && typeof row.flows === "object") {
    for (const [column, flow] of Object.entries(row.flows as Record<string, unknown>)) {
      const path = str(flow);
      if (path) flows[column] = path;
    }
  }
  const block: ConductorBlock = {
    flow: str(row.flow),
    flows: Object.keys(flows).length ? flows : undefined,
  };
  return block.flow || block.flows ? block : undefined;
}

/** `raw` is an already-parsed YAML mapping. Returns null for a malformed file. */
export function parseCase(
  raw: Record<string, unknown>,
  filePath: string,
  projectCode: string,
): Case | null {
  if (!raw || typeof raw !== "object") return null;
  const id = num(raw.id);
  const title = str(raw.title);
  if (id === undefined || !title) return null;

  const automation = (raw.conductor as Record<string, unknown> | undefined)?.steps;
  return {
    id,
    ref: `${projectCode}-${id}`,
    title,
    description: str(raw.description),
    preconditions: str(raw.preconditions),
    postconditions: str(raw.postconditions),
    severity: decodeEnum(SEVERITIES, raw.severity),
    priority: decodeEnum(PRIORITIES, raw.priority),
    type: decodeEnum(CASE_TYPES, raw.type),
    behavior: decodeEnum(BEHAVIORS, raw.behavior),
    status: decodeEnum(CASE_STATUSES, raw.status) ?? "actual",
    is_manual: raw.is_manual === undefined ? true : Boolean(raw.is_manual),
    suite_id: num(raw.suite_id),
    suite: str(raw.suite),
    milestone_id: num(raw.milestone_id),
    steps_type: raw.steps_type === "gherkin" ? "gherkin" : "classic",
    steps: parseSteps(raw.steps, automation),
    custom_fields: parseCustomFields(raw.custom_fields),
    tags: strList(raw.tags),
    external_issues: strList(raw.external_issues).length ? strList(raw.external_issues) : undefined,
    author_id: num(raw.author_id),
    created_at: str(raw.created_at),
    updated_at: str(raw.updated_at),
    conductor: parseConductor(raw.conductor),
    filePath,
  };
}

/**
 * Keep short lists on one line (`tags: [auth, p0]`) — block style turns a
 * compact case file into a page of bullets on every save.
 */
function flowStyle(doc: Document, value: unknown): unknown {
  const node = doc.createNode(value);
  if (isSeq(node)) node.flow = true;
  if (isMap(node)) {
    for (const item of node.items) if (isSeq(item.value)) item.value.flow = true;
  }
  return node;
}

/** Keys serialize() manages; an absent value deletes them rather than leaving a stale one. */
const MANAGED = [
  "id",
  "title",
  "description",
  "preconditions",
  "postconditions",
  "severity",
  "priority",
  "type",
  "behavior",
  "status",
  "is_manual",
  "suite_id",
  "suite",
  "milestone_id",
  "steps_type",
  "steps",
  "custom_fields",
  "tags",
  "external_issues",
  "author_id",
  "created_at",
  "updated_at",
  "conductor",
] as const;

/**
 * Write a case into a Document, splitting pom/env back out of the steps into
 * the `conductor` block. Enums are written as names, not Qase's integers — the
 * file is meant to be readable.
 */
export function writeCase(doc: Document, c: Case): void {
  const automation = (c.steps ?? []).map((s) => ({
    ...(s.pom ? { pom: s.pom } : {}),
    ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}),
  }));
  const hasAutomation = automation.some((a) => Object.keys(a).length);

  const conductor =
    c.conductor?.flow || c.conductor?.flows || hasAutomation
      ? {
          ...(c.conductor?.flow ? { flow: c.conductor.flow } : {}),
          ...(c.conductor?.flows ? { flows: c.conductor.flows } : {}),
          ...(hasAutomation ? { steps: automation } : {}),
        }
      : undefined;

  const values: Record<string, unknown> = {
    id: c.id,
    title: c.title,
    description: c.description,
    preconditions: c.preconditions,
    postconditions: c.postconditions,
    severity: c.severity,
    priority: c.priority,
    type: c.type,
    behavior: c.behavior,
    status: c.status,
    is_manual: c.is_manual,
    suite_id: c.suite_id,
    suite: c.suite,
    milestone_id: c.milestone_id,
    steps_type: c.steps_type === "gherkin" ? "gherkin" : undefined,
    steps: c.steps?.length
      ? c.steps.map((s) => ({
          ...(s.hash ? { hash: s.hash } : {}),
          action: s.action,
          ...(s.data ? { data: s.data } : {}),
          ...(s.expected_result ? { expected_result: s.expected_result } : {}),
        }))
      : undefined,
    custom_fields: Object.keys(c.custom_fields ?? {}).length ? c.custom_fields : undefined,
    tags: c.tags?.length ? c.tags : undefined,
    external_issues: c.external_issues?.length ? c.external_issues : undefined,
    author_id: c.author_id,
    created_at: c.created_at,
    updated_at: c.updated_at,
    conductor,
  };

  for (const key of MANAGED) {
    const value = values[key];
    if (value === undefined) {
      doc.delete(key);
      continue;
    }
    doc.set(key, key === "custom_fields" || key === "tags" ? flowStyle(doc, value) : value);
  }
}

/** `DEMO-12 Can I …?` -> `DEMO-12-can-i.yaml`. */
export function fileNameFor(ref: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
    .replace(/-$/, "");
  return `${ref}${slug ? `-${slug}` : ""}.yaml`;
}
