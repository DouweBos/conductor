/**
 * Qase's case entity, in Studio's shape. Decoding only — Qase owns the content
 * and Studio never writes it back, so this is the whole of the translation.
 *
 * Electron-free by design so it stays testable as plain Node.
 */

import {
  BEHAVIORS,
  CASE_STATUSES,
  CASE_TYPES,
  PRIORITIES,
  SEVERITIES,
  decodeEnum,
  type Case,
} from "./model";
import type { QaseCase, QaseCustomField, QaseSuite } from "./qaseClient";

const ENTITIES: Record<string, string> = {
  quot: '"',
  apos: "'",
  amp: "&",
  lt: "<",
  gt: ">",
  nbsp: " ",
  hellip: "…",
  ndash: "–",
  mdash: "—",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
};

/**
 * Qase stores case prose HTML-escaped — a title comes back as
 * `a show&#039;s details`. One pass, so a decoded `&amp;` is not re-decoded.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|\w+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1]?.toLowerCase() === "x"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** The same, for a field Qase may not send at all. */
function decoded<T extends string | null | undefined>(text: T): T {
  return (typeof text === "string" ? decodeEntities(text) : text) as T;
}

/** A custom field, with the option table its values are ids into. */
export interface FieldDef {
  title: string;
  /** Option id -> its title, for selectbox/multiselect fields. */
  options: Map<string, string>;
}

/**
 * A case carries option *ids* for select-type fields, so without the field's
 * own option list "Media Source: 2" is all Studio can show. Qase sends the
 * options either as an array or as that array JSON-encoded.
 */
export function fieldDef(field: QaseCustomField): FieldDef {
  const raw = typeof field.value === "string" ? parseJson(field.value) : field.value;
  const options = new Map<string, string>();
  for (const option of Array.isArray(raw) ? raw : []) {
    const { id, title } = (option ?? {}) as { id?: unknown; title?: unknown };
    if (id !== undefined && typeof title === "string") options.set(String(id), decodeEntities(title));
  }
  return { title: decodeEntities(field.title), options };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** A suite and where it sits in Qase's tree. */
export interface SuiteDef {
  title: string;
  /** Root-first titles, ending with this suite's own. */
  path: string[];
}

/** Resolve each suite's ancestry once, so a case only has to look itself up. */
export function suiteTree(suites: QaseSuite[]): Map<number, SuiteDef> {
  const byId = new Map(suites.map((s) => [s.id, s]));
  const defs = new Map<number, SuiteDef>();
  const pathOf = (id: number, seen: Set<number>): string[] => {
    const suite = byId.get(id);
    // A cycle can only come from bad data, but it must not hang the fetch.
    if (!suite || seen.has(id)) return [];
    seen.add(id);
    const title = decodeEntities(suite.title);
    return suite.parent_id ? [...pathOf(suite.parent_id, seen), title] : [title];
  };
  for (const suite of suites) {
    const path = pathOf(suite.id, new Set());
    defs.set(suite.id, { title: path[path.length - 1] ?? decodeEntities(suite.title), path });
  }
  return defs;
}

export function toCase(
  entity: QaseCase,
  projectCode: string,
  suites: Map<number, SuiteDef>,
  fields: Map<number, FieldDef>,
): Case {
  const custom_fields: Record<string, string[]> = {};
  for (const field of entity.custom_fields ?? []) {
    const def = fields.get(field.id);
    if (!def) continue;
    // Multi-selects come back as a comma-joined string of option ids; a
    // free-text field has no options, so its value is the value.
    const values = String(field.value ?? "")
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((v) => v.trim().replace(/^"|"$/g, ""))
      .filter(Boolean)
      .map((v) => def.options.get(v) ?? decodeEntities(v));
    if (values.length) custom_fields[def.title] = values;
  }

  const external = (entity.external_issues ?? [])
    .map((issue) => issue.link ?? issue.id)
    .filter((v): v is string => Boolean(v));

  return {
    id: entity.id,
    ref: `${projectCode}-${entity.id}`,
    title: decodeEntities(entity.title),
    description: decoded(entity.description) ?? undefined,
    preconditions: decoded(entity.preconditions) ?? undefined,
    postconditions: decoded(entity.postconditions) ?? undefined,
    severity: decodeEnum(SEVERITIES, entity.severity),
    priority: decodeEnum(PRIORITIES, entity.priority),
    type: decodeEnum(CASE_TYPES, entity.type),
    behavior: decodeEnum(BEHAVIORS, entity.behavior),
    status: decodeEnum(CASE_STATUSES, entity.status) ?? "actual",
    is_manual: entity.is_manual ?? entity.isManual ?? true,
    suite_id: entity.suite_id ?? undefined,
    suite: entity.suite_id ? suites.get(entity.suite_id)?.title : undefined,
    suite_path: entity.suite_id ? suites.get(entity.suite_id)?.path : undefined,
    milestone_id: entity.milestone_id ?? undefined,
    steps_type: entity.steps_type === "gherkin" ? "gherkin" : "classic",
    steps: (entity.steps ?? [])
      .filter((s) => s.action?.trim())
      .map((s) => ({
        hash: s.hash,
        action: decodeEntities((s.action as string).trim()),
        data: decoded(s.data) ?? undefined,
        expected_result: decoded(s.expected_result) ?? undefined,
      })),
    custom_fields,
    tags: (entity.tags ?? []).map((t) => decodeEntities(t.title)).filter(Boolean),
    external_issues: external.length ? external : undefined,
    author_id: entity.author_id,
    created_at: entity.created_at,
    updated_at: entity.updated_at,
  };
}
