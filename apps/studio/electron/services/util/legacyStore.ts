import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import path from "node:path";

/**
 * Move a store that was written flat (one project per repo) into the
 * sub-project directory that inherits it. Runs once per target: an existing
 * directory means the move already happened, and nothing else may claim files
 * a sub-project has adopted.
 */
export function adoptFlatStore(base: string, dir: string): void {
  if (existsSync(dir) || !existsSync(base)) return;
  const loose = readdirSync(base, { withFileTypes: true }).filter(
    (entry) => entry.isFile() && /\.(ya?ml|jsonl)$/i.test(entry.name),
  );
  if (!loose.length) return;
  mkdirSync(dir, { recursive: true });
  for (const entry of loose) {
    renameSync(path.join(base, entry.name), path.join(dir, entry.name));
  }
}

/**
 * Move a directory written under an older layout to where it lives now, once.
 * A target that already exists is the current layout and wins; the old parent
 * is dropped when the move empties it.
 */
export function adoptLegacyDir(from: string, to: string): void {
  if (existsSync(to) || !existsSync(from)) return;
  mkdirSync(path.dirname(to), { recursive: true });
  renameSync(from, to);
  try {
    rmdirSync(path.dirname(from));
  } catch {
    // Another project still has data under the old parent.
  }
}
