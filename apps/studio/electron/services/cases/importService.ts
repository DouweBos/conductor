import { readFile, writeFile } from "node:fs/promises";

import type { CasePreview, ImportResult, TestCaseInput } from "../../../app/lib/types";
import { listCases, saveCase } from "./casesService";

/**
 * Getting a matrix out of a spreadsheet and back again. Teams arrive with their
 * cases in Qase/TestRail/Sheets exports, and leave wanting the same shape back,
 * so import and export are part of the product rather than a one-off script.
 */

/** Case fields a CSV column can feed. `""` means "ignore this column". */
export const IMPORT_FIELDS = [
  "id",
  "title",
  "userStory",
  "description",
  "owner",
  "state",
  "links",
  "flow",
  "altIds",
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
  userstory: "userStory",
  businessrule: "userStory",
  businessrulecoverage: "userStory",
  expectedresult: "userStory",
  description: "description",
  steps: "description",
  actionstotest: "description",
  preconditions: "description",
  owner: "owner",
  assignee: "owner",
  status: "state",
  automationstatus: "state",
  state: "state",
  flow: "flow",
  link: "links",
  links: "links",
  url: "links",
  ticket: "links",
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
    mapping[header] = guess ?? (header ? `tag:${header.trim()}` : "");
  }
  return { headers, rows: rows.slice(0, 20), mapping };
}

export interface ImportOptions {
  file: string;
  mapping: Record<string, string>;
  /** Tag dimension + value stamped on every imported case, e.g. platform=tv. */
  stamp?: Record<string, string>;
  /** Overwrite cases whose id already exists. */
  overwrite?: boolean;
}

export async function importCsv(options: ImportOptions): Promise<ImportResult> {
  const rows = parseCsv(await readFile(options.file, "utf8"));
  const headers = (rows.shift() ?? []).map((h) => h.trim());
  const existing = new Set((await listCases()).map((c) => c.id));
  const result: ImportResult = { created: 0, updated: 0, skipped: 0, ids: [] };

  for (const row of rows) {
    const input: TestCaseInput = { id: "", title: "", tags: {} };
    for (const [dim, value] of Object.entries(options.stamp ?? {})) {
      if (value) input.tags[dim] = [value];
    }
    headers.forEach((header, i) => {
      const target = options.mapping[header];
      const value = (row[i] ?? "").trim();
      if (!target || !value) return;
      if (target.startsWith("tag:")) {
        const dim = target.slice(4);
        input.tags[dim] = [...new Set([...(input.tags[dim] ?? []), value])];
        return;
      }
      if (target === "links" || target === "altIds") {
        input[target] = value.split(/[,\s]+/).filter(Boolean);
        return;
      }
      (input as unknown as Record<string, unknown>)[target] = value;
    });

    if (!input.id || !input.title) {
      result.skipped++;
      continue;
    }
    if (existing.has(input.id) && !options.overwrite) {
      result.skipped++;
      continue;
    }
    // Overwriting a known id is an edit of that case, not a new one.
    await saveCase(existing.has(input.id) ? { ...input, previousId: input.id } : input);
    result.ids.push(input.id);
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
  const dimensions = [...new Set(cases.flatMap((c) => Object.keys(c.tags)))].sort();
  const headers = [
    "id",
    "altIds",
    "title",
    "userStory",
    "description",
    "owner",
    "state",
    "links",
    ...dimensions,
    "flows",
    "lastVerdict",
    "lastRunAt",
  ];
  const lines = [headers.map(cell).join(",")];
  for (const c of cases) {
    const flows = Object.entries(c.flows ?? {})
      .map(([column, flow]) => `${column}=${flow}`)
      .concat(c.flow ? [c.flow] : [])
      .join(" ");
    lines.push(
      [
        c.id,
        (c.altIds ?? []).join(" "),
        c.title,
        c.userStory ?? "",
        c.description ?? "",
        c.owner ?? "",
        c.state ?? "",
        (c.links ?? []).join(" "),
        ...dimensions.map((d) => (c.tags[d] ?? []).join(" ")),
        flows,
        c.lastResult?.verdict ?? "",
        c.lastResult ? new Date(c.lastResult.at).toISOString() : "",
      ]
        .map(cell)
        .join(","),
    );
  }
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
  return cases.length;
}
