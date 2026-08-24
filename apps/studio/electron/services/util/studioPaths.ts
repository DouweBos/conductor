import { homedir } from "node:os";
import path from "node:path";

import { appState } from "../../state";
import { adoptLegacyDir } from "./legacyStore";

/**
 * Where Studio keeps the things it owns: `~/.conductor/studio`, scoped per
 * project, alongside scene graphs and reports.
 *
 * Cases and their results live here rather than in the repo under test. A
 * project's repo holds its flows — those are the tests, and they belong in git.
 * Studio's own bookkeeping does not get to add files to someone else's tree.
 */
export const STUDIO_ROOT = path.join(homedir(), ".conductor", "studio");

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "project"
  );
}

function hash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/** `react-native-client-1f4k2z` — readable, and unique per checkout path. */
export function projectSlug(root?: string | null): string {
  const target = root ?? appState.projectRoot;
  if (!target) return "no-project";
  return `${slug(path.basename(target))}-${hash(target)}`;
}

/**
 * A store belonging to one project, e.g. `cases`. The project comes first:
 * everything Studio keeps about a checkout sits in one directory, so it reads
 * (and deletes) as a unit rather than as a row in every store.
 */
export function studioDir(store: string, root?: string | null): string {
  const project = projectSlug(root);
  const dir = path.join(STUDIO_ROOT, project, store);
  // The layout before that put the store first.
  adoptLegacyDir(path.join(STUDIO_ROOT, store, project), dir);
  return dir;
}
