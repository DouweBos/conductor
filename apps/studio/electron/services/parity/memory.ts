/**
 * What each target's loop has learned, kept across goals.
 *
 * This is the part of the Helix design that makes the loop *get better*:
 * "feedback from every review is remembered, so the loop gets more autonomous
 * as the migration progresses." Without it every goal starts from zero — the
 * agent re-learns how the tvOS app is built, re-discovers the identifier
 * convention, and makes the same mistake a reviewer already sent back once.
 *
 * One markdown file per target under `.conductor/parity/memory/`, appended to
 * by three writers: the agent (through an MCP tool), a reviewer's rejection
 * note, and the loop itself when it establishes a fact (a build recipe worked,
 * a round stalled on the same finding twice). Read in full into every brief,
 * newest last, capped so a long-lived target can't crowd the brief out.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { MemoryEntry, TargetMemory } from "../../../app/lib/types";
import { appState } from "../../state";
import { slugForLabel } from "./labels";

/** Characters of memory a brief will carry. Older entries drop off the top. */
export const MEMORY_BRIEF_CAP = 6_000;

function memoryDir(): string {
  const root = appState.projectRoot ?? process.cwd();
  return path.join(root, ".conductor", "parity", "memory");
}

export function memoryPath(label: string): string {
  return path.join(memoryDir(), `${slugForLabel(label)}.md`);
}

const HEADER = /^## (\d{4}-\d{2}-\d{2}T[^\s]+) · (agent|reviewer|loop)$/;

/** Parse the file back into entries. Tolerates hand edits: unparsed text is kept. */
export function parseMemory(label: string, text: string): TargetMemory {
  const entries: MemoryEntry[] = [];
  let current: MemoryEntry | null = null;
  const flush = (): void => {
    if (current) {
      current.text = current.text.trim();
      if (current.text) entries.push(current);
    }
  };
  for (const line of text.split("\n")) {
    const m = HEADER.exec(line.trim());
    if (m) {
      flush();
      current = { at: Date.parse(m[1]) || 0, source: m[2] as MemoryEntry["source"], text: "" };
      continue;
    }
    if (!current) {
      // Text before any header — someone edited the file by hand. Keep it.
      current = { at: 0, source: "loop", text: "" };
    }
    current.text += line + "\n";
  }
  flush();
  return { label, entries };
}

export async function readMemory(label: string): Promise<TargetMemory> {
  try {
    return parseMemory(label, await readFile(memoryPath(label), "utf-8"));
  } catch {
    return { label, entries: [] };
  }
}

export async function remember(
  label: string,
  source: MemoryEntry["source"],
  text: string,
): Promise<void> {
  const body = text.trim();
  if (!body) return;
  await mkdir(memoryDir(), { recursive: true });
  const stamp = new Date().toISOString();
  await appendFile(memoryPath(label), `\n## ${stamp} · ${source}\n${body}\n`, "utf-8");
}

/**
 * The memory as it goes into a brief: newest entries kept when the cap bites,
 * because the most recent reviewer note is the one most likely to be about the
 * thing the agent is doing right now.
 */
export function renderMemoryForBrief(memory: TargetMemory, cap = MEMORY_BRIEF_CAP): string {
  if (memory.entries.length === 0) return "";
  const lines = memory.entries.map((e) => {
    const who = e.source === "reviewer" ? "a reviewer said" : e.source === "agent" ? "you noted" : "the loop found";
    return `- (${who}) ${e.text.replace(/\s+/g, " ")}`;
  });
  let out: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (size + lines[i].length > cap) break;
    out.unshift(lines[i]);
    size += lines[i].length;
  }
  const dropped = lines.length - out.length;
  return [
    "## What is already known about this target",
    ...(dropped ? [`- (${dropped} older note${dropped === 1 ? "" : "s"} omitted)`] : []),
    ...out,
  ].join("\n");
}
