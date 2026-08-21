import { readFile, writeFile } from "node:fs/promises";

import type { CasePreview, ImportResult } from "../../../app/lib/types";
import { datasource, listCases, nextLocalId, saveCase } from "./casesService";
import { CASE_STATUSES, PRIORITIES, SEVERITIES, decodeEnum, type CaseInput } from "./model";

/**
 * Getting a matrix out of a spreadsheet and back again. Teams arrive with their
 * cases in Qase/TestRail/Sheets exports, and leave wanting the same shape back,
 * so import and export are part of the product rather than a one-off script.
 */

/** Case fields a CSV column can feed. `""` means "ignore this column". */
export const IMPORT_FIELDS = [
  "id",
  "title",
  "description",
  "preconditions",
  "postconditions",
  "severity",
  "priority",
  "status",
  "tags",
  "flow",
] as const;

/** Header names we recognise without being told, lower-cased and de-punctuated. */
const GUESSES: Record<string, string> = {
  id: "id",
  case: "id",
  caseid: "id",
  key: "id",
  title: "title",
  testcase: "title",
  name: "title",
  summary: "title",
  userstory: "description",
  businessrule: "description",
  businessrulecoverage: "description",
  description: "description",
  steps: "description",
  actionstotest: "description",
  preconditions: "preconditions",
  postconditions: "postconditions",
  severity: "severity",
  priority: "priority",
  status: "status",
  state: "status",
  flow: "flow",
  tags: "tags",
  tag: "tags",
  labels: "tags",
};

const key = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, "");

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cur);
      cur = "";
    } else if (c === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else if (c !== "\r") cur += c;
  }
  if (cur || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim()));
}

/** Read a CSV and guess what each column is, for the user to confirm. */
export async function previewCsv(file: string): Promise<CasePreview> {
  const rows = parseCsv(await readFile(file, "utf8"));
  const headers = (rows.shift() ?? []).map((h) => h.trim());
  const mapping: Record<string, string> = {};
  for (const header of headers) {
    const guess = GUESSES[key(header)];
    // Anything unrecognised becomes a tag dimension named after the column —
    // that is how a "Priority"/"Main Area" column ends up as a matrix filter.
    mapping[header] = guess ?? (header ? `field:${header.trim()}` : "");
  }
  return { headers, rows: rows.slice(0, 20), mapping };
}

export interface ImportOptions {
  file: string;
  mapping: Record<string, string>;
  /** Custom field + value stamped on every imported case, e.g. Platform=tv. */
  stamp?: Record<string, string>;
  /** Overwrite cases whose id already exists. */
  overwrite?: boolean;
}

export async function importCsv(options: ImportOptions): Promise<ImportResult> {
  const rows = parseCsv(await readFile(options.file, "utf8"));
  const headers = (rows.shift() ?? []).map((h) => h.trim());
  const { projectCode } = datasource();
  const existing = new Set((await listCases()).map((c) => c.id));
  const result: ImportResult = { created: 0, updated: 0, skipped: 0, refs: [] };
  // A CSV without an id column still imports; ids are handed out locally.
  let nextId = await nextLocalId();

  for (const row of rows) {
    const input: CaseInput = { id: 0, title: "", custom_fields: {}, tags: [] };
    let flow: string | undefined;
    for (const [field, value] of Object.entries(options.stamp ?? {})) {
      if (value) input.custom_fields![field] = [value];
    }
    headers.forEach((header, i) => {
      const target = options.mapping[header];
      const value = (row[i] ?? "").trim();
      if (!target || !value) return;
      if (target.startsWith("field:")) {
        const field = target.slice(6);
        const fields = input.custom_fields!;
        fields[field] = [...new Set([...(fields[field] ?? []), value])];
        return;
      }
      switch (target) {
        case "id":
          // Accept both `12` and Qase's `DEMO-12`.
          input.id = Number(value.replace(/^.*-/, "")) || 0;
          return;
        case "tags":
          input.tags = value.split(/[,\s]+/).filter(Boolean);
          return;
        case "severity":
          input.severity = decodeEnum(SEVERITIES, value.toLowerCase());
          return;
        case "priority":
          input.priority = decodeEnum(PRIORITIES, value.toLowerCase());
          return;
        case "status":
          input.status = decodeEnum(CASE_STATUSES, value.toLowerCase());
          return;
        case "flow":
          flow = value;
          return;
        default:
          (input as unknown as Record<string, unknown>)[target] = value;
      }
    });

    if (!input.title) {
      result.skipped++;
      continue;
    }
    if (!input.id) input.id = nextId++;
    if (existing.has(input.id) && !options.overwrite) {
      result.skipped++;
      continue;
    }
    if (flow) input.conductor = { flow };

    // Overwriting a known id is an edit of that case, not a new one.
    await saveCase(existing.has(input.id) ? { ...input, previousId: input.id } : input);
    result.refs.push(`${projectCode}-${input.id}`);
    if (existing.has(input.id)) result.updated++;
    else result.created++;
    existing.add(input.id);
  }
  return result;
}

const cell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/** Everything the matrix knows, as a CSV — including the automation status. */
export async function exportCsv(file: string): Promise<number> {
  const cases = await listCases();
  const fields = [...new Set(cases.flatMap((c) => Object.keys(c.custom_fields)))].sort();
  const headers = [
    "id",
    "title",
    "description",
    "preconditions",
    "postconditions",
    "suite",
    "severity",
    "priority",
    "type",
    "status",
    "tags",
    ...fields,
    "flows",
    "lastStatus",
    "lastRunAt",
  ];
  const lines = [headers.map(cell).join(",")];
  for (const c of cases) {
    const flows = Object.entries(c.conductor?.flows ?? {})
      .map(([column, flow]) => `${column}=${flow}`)
      .concat(c.conductor?.flow ? [c.conductor.flow] : [])
      .join(" ");
    lines.push(
      [
        c.ref,
        c.title,
        c.description ?? "",
        c.preconditions ?? "",
        c.postconditions ?? "",
        c.suite ?? "",
        c.severity ?? "",
        c.priority ?? "",
        c.type ?? "",
        c.status,
        c.tags.join(" "),
        ...fields.map((f) => (c.custom_fields[f] ?? []).join(" ")),
        flows,
        c.lastResult?.status ?? "",
        c.lastResult ? new Date(c.lastResult.at).toISOString() : "",
      ]
        .map(cell)
        .join(","),
    );
  }
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
  return cases.length;
}
