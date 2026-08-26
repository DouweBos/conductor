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
import type { QaseCase } from "./qaseClient";

export function toCase(
  entity: QaseCase,
  projectCode: string,
  suites: Map<number, string>,
  fields: Map<number, string>,
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
  };
}
