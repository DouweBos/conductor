export const HELP = `  cases list                          List the repo's test cases and their coverage
  cases report --junit <file>         File a JUnit report as test-case results
  cases result <id> --verdict <v>     Record one case result (passed/failed/blocked/skipped)`;

import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { printData, printError, OutputOptions } from '../output.js';

/**
 * Test cases from the CLI, so CI can file results without Studio running.
 *
 * Cases and their results live under `~/.conductor/studio/cases/<project>/`,
 * outside the repo under test — testing a project never adds files to it. The
 * project is identified by its path, the same way Studio scopes its own store,
 * so both see the same cases for the same checkout.
 */

const RESULTS = 'results.jsonl';
/** Legacy in-repo location, still read so an older checkout keeps working. */
const IN_REPO_CASES = 'test-cases';

function studioRoot(): string {
  // __CONDUCTOR_STUDIO_DIR keeps tests (and CI sandboxes) out of the real home.
  return process.env.__CONDUCTOR_STUDIO_DIR ?? path.join(homedir(), '.conductor', 'studio');
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'project'
  );
}

function hash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/** `<basename>-<hash of path>`, matching Studio's own project scoping. */
export function storeDir(root: string): string {
  const resolved = path.resolve(root);
  return path.join(studioRoot(), 'cases', `${slug(path.basename(resolved))}-${hash(resolved)}`);
}

/** Where cases are read from: the store, falling back to a legacy in-repo dir. */
function casesDir(root: string): string {
  const store = storeDir(root);
  if (existsSync(store)) return store;
  const legacy = path.join(root, IN_REPO_CASES);
  return existsSync(legacy) ? legacy : store;
}

export type Verdict = 'passed' | 'failed' | 'blocked' | 'skipped';

interface CaseFile {
  id: string;
  title: string;
  flow?: string;
  flows?: Record<string, string>;
  tags?: Record<string, string[]>;
}

/** Minimal YAML reader for the case fields we need — no dependency for one shape. */
function readCase(text: string): CaseFile | null {
  const lines = text.split(/\r?\n/);
  const scalar = (key: string): string | undefined => {
    const hit = lines.find((l) => l.startsWith(`${key}:`));
    return hit
      ?.slice(key.length + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
  };
  const id = scalar('id');
  const title = scalar('title');
  if (!id || !title) return null;

  // `flows:` is a nested block: read indented `column: path` until the indent ends.
  const flows: Record<string, string> = {};
  const start = lines.findIndex((l) => /^flows:\s*$/.test(l));
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      if (!line.trim()) continue;
      if (!/^\s/.test(line)) break;
      const entry = /^\s+([\w-]+):\s*(.+)$/.exec(line);
      if (entry) flows[entry[1]] = entry[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return {
    id,
    title,
    flow: scalar('flow'),
    flows: Object.keys(flows).length ? flows : undefined,
  };
}

export async function loadCases(root: string): Promise<CaseFile[]> {
  const dir = casesDir(root);
  if (!existsSync(dir)) return [];
  const cases: CaseFile[] = [];
  for (const file of (await readdir(dir)).filter((f) => /\.ya?ml$/i.test(f))) {
    const parsed = readCase(await readFile(path.join(dir, file), 'utf8'));
    if (parsed) cases.push(parsed);
  }
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

function flowsOf(c: CaseFile): { column?: string; flow: string }[] {
  const entries: { column?: string; flow: string }[] = Object.entries(c.flows ?? {}).map(
    ([column, flow]) => ({ column, flow })
  );
  if (c.flow) entries.push({ flow: c.flow });
  return entries;
}

let seq = 0;

async function append(root: string, results: Record<string, unknown>[]): Promise<void> {
  const file = path.join(storeDir(root), RESULTS);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, results.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function result(fields: Record<string, unknown>): Record<string, unknown> {
  seq += 1;
  return { id: `res-${Date.now()}-${seq}`, at: Date.now(), ...fields };
}

export async function casesList(root: string, opts: OutputOptions = {}): Promise<number> {
  const cases = await loadCases(root);
  if (!cases.length) {
    printError(`No test cases found under ${casesDir(root)}.`, opts);
    return 1;
  }
  if (opts.json) {
    printData(
      {
        status: 'ok',
        total: cases.length,
        automated: cases.filter((c) => flowsOf(c).length).length,
        cases: cases.map((c) => ({ id: c.id, title: c.title, flows: flowsOf(c) })),
      },
      opts
    );
  } else {
    console.log(
      `${cases.length} cases, ${cases.filter((c) => flowsOf(c).length).length} with a flow`
    );
    for (const c of cases) {
      console.log(`  ${c.id.padEnd(10)} ${c.title}${flowsOf(c).length ? '' : '   (no flow)'}`);
    }
  }
  return 0;
}

/** `<testcase name="…" classname="…">` plus its failure/skipped child, if any. */
export function parseJunit(xml: string): { name: string; failed: boolean; skipped: boolean }[] {
  const out: { name: string; failed: boolean; skipped: boolean }[] = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) {
    const attrs = match[1];
    const body = match[3] ?? '';
    const name = /\bname="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const classname = /\bclassname="([^"]*)"/.exec(attrs)?.[1] ?? '';
    out.push({
      name: [classname, name].filter(Boolean).join(' '),
      failed: /<(failure|error)\b/.test(body),
      skipped: /<skipped\b/.test(body),
    });
  }
  return out;
}

/** Whole-word id match, so DT-9 doesn't claim a test named for DT-97. */
function mentionsId(entry: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, 'i').test(entry);
}

/** A report entry belongs to a flow when it names the file or its basename. */
function matchesFlow(entry: string, flow: string): boolean {
  const name = entry.toLowerCase();
  const base = (flow.split('/').pop() ?? flow).toLowerCase();
  return (
    name.includes(flow.toLowerCase()) ||
    name.includes(base) ||
    name.includes(base.replace(/\.[^.]+$/, ''))
  );
}

export interface ReportOptions extends OutputOptions {
  build?: string;
  environment?: string;
}

export async function casesReport(
  root: string,
  junitPath: string,
  opts: ReportOptions = {}
): Promise<number> {
  if (!junitPath) {
    printError('Usage: conductor cases report --junit <file.xml>', opts);
    return 1;
  }
  if (!existsSync(junitPath)) {
    printError(`No such JUnit file: ${junitPath}`, opts);
    return 1;
  }
  const entries = parseJunit(await readFile(junitPath, 'utf8'));
  const cases = await loadCases(root);
  const records: Record<string, unknown>[] = [];
  const unmatched: string[] = [];

  for (const entry of entries) {
    // Prefer the flow: it says which platform column ran. An id in the test
    // name only identifies the case, so it files one case-level result.
    const byFlow: { c: CaseFile; column?: string; flow: string }[] = [];
    for (const c of cases) {
      for (const { column, flow } of flowsOf(c)) {
        if (matchesFlow(entry.name, flow)) byFlow.push({ c, column, flow });
      }
    }
    const targets = byFlow.length
      ? byFlow
      : cases
          .filter((c) => mentionsId(entry.name, c.id))
          .map((c) => ({ c, column: undefined, flow: undefined }));

    if (!targets.length) {
      unmatched.push(entry.name);
      continue;
    }
    for (const target of targets) {
      records.push(
        result({
          caseId: target.c.id,
          column: target.column,
          flow: target.flow,
          verdict: entry.skipped ? 'skipped' : entry.failed ? 'failed' : 'passed',
          source: 'ci',
          note: entry.name,
          build: opts.build,
          environment: opts.environment,
        })
      );
    }
  }

  if (records.length) await append(root, records);
  if (opts.json) {
    printData({ status: 'ok', reported: records.length, tests: entries.length, unmatched }, opts);
  } else {
    console.log(
      `Filed ${records.length} results from ${entries.length} tests` +
        (unmatched.length ? `; ${unmatched.length} matched no case` : '')
    );
  }
  return 0;
}

export async function casesResult(
  root: string,
  caseId: string,
  verdict: Verdict,
  opts: ReportOptions & { note?: string; column?: string } = {}
): Promise<number> {
  if (!caseId || !verdict) {
    printError(
      'Usage: conductor cases result <case-id> --verdict passed|failed|blocked|skipped',
      opts
    );
    return 1;
  }
  const known = await loadCases(root);
  if (known.length && !known.some((c) => c.id === caseId)) {
    printError(`No case "${caseId}" under ${casesDir(root)}.`, opts);
    return 1;
  }
  await append(root, [
    result({
      caseId,
      verdict,
      column: opts.column,
      source: 'ci',
      note: opts.note,
      build: opts.build,
      environment: opts.environment,
    }),
  ]);
  if (opts.json) printData({ status: 'ok', caseId, verdict }, opts);
  else console.log(`Recorded ${caseId}: ${verdict}`);
  return 0;
}
