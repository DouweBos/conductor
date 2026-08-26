import { existsSync, mkdirSync, renameSync, rmdirSync } from "node:fs";
import path from "node:path";

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
