/**
 * Git, scoped to one target's source directory.
 *
 * Every target's agent works in the same checkout. tvOS and Android TV are
 * usually different directories of one monorepo, so "commit this target's
 * work" has to mean "commit *these paths*" — `git add -A` from the root would
 * sweep another target's half-finished round into the commit. No scope, no
 * commit; the loop says so rather than guessing.
 */
import { run } from "../util/exec";

export interface ScopedDiff {
  diff: string;
  untracked: string[];
  /** True when there is nothing to show — no changes in scope. */
  empty: boolean;
}

export async function isGitRepo(root: string): Promise<boolean> {
  try {
    const r = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, timeout: 10_000 });
    return r.code === 0 && r.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** Working-tree changes against HEAD inside `scope`, plus files git doesn't know yet. */
export async function scopedDiff(root: string, scope: string): Promise<ScopedDiff> {
  const [diff, status] = await Promise.all([
    run("git", ["diff", "HEAD", "--", scope], { cwd: root, timeout: 30_000 }),
    run("git", ["status", "--porcelain", "--untracked-files=all", "--", scope], {
      cwd: root,
      timeout: 30_000,
    }),
  ]);
  const untracked = status.stdout
    .split(/\r?\n/)
    .filter((l) => l.startsWith("??"))
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
  const text = diff.code === 0 ? diff.stdout : "";
  return { diff: text, untracked, empty: !text.trim() && untracked.length === 0 };
}

/**
 * Stage and commit everything inside `scope`. Returns the new sha, or a note
 * saying why there is no commit — nothing to commit is not a failure.
 */
export async function commitScope(
  root: string,
  scope: string,
  message: string,
): Promise<{ sha?: string; note: string }> {
  const add = await run("git", ["add", "-A", "--", scope], { cwd: root, timeout: 30_000 });
  if (add.code !== 0) return { note: `git add failed: ${add.stderr.trim()}` };

  const staged = await run("git", ["diff", "--cached", "--quiet", "--", scope], { cwd: root, timeout: 30_000 });
  if (staged.code === 0) return { note: "nothing to commit in scope" };

  const commit = await run("git", ["commit", "-m", message, "--", scope], { cwd: root, timeout: 60_000 });
  if (commit.code !== 0) return { note: `git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}` };

  const sha = await run("git", ["rev-parse", "--short", "HEAD"], { cwd: root, timeout: 10_000 });
  return { sha: sha.stdout.trim() || undefined, note: `committed ${scope}` };
}
