/**
 * How one flow names another. Shared by the main process (rename, usages,
 * linting) and the renderer (go-to-definition, completion) so both agree on
 * exactly what a `runFlow: "@pages/x.yaml"` points at.
 *
 * Alias semantics mirror conductor's `resolvePath`: `@name/rest` maps `name`
 * through `paths:` in the flows directory's config.yaml.
 *
 * Path handling is hand-rolled posix rather than `node:path` because the
 * renderer imports this too, and Vite externalizes node builtins.
 */

export type ReferenceStyle = "alias" | "relative";

/** Lines that name a file: `runFlow: x`, `runScript: x`, `file: x`. */
export const REFERENCE_LINE =
  /^(\s*-?\s*(?:runFlow|runScript|file)\s*:\s*)(['"]?)([@\w./-]+\.(?:ya?ml|js|ts))\2/;

function normalize(target: string): string {
  const parts: string[] = [];
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts[parts.length - 1] !== "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function dirname(target: string): string {
  const cut = target.lastIndexOf("/");
  return cut < 0 ? "" : target.slice(0, cut);
}

function relative(from: string, to: string): string {
  const a = normalize(from).split("/").filter(Boolean);
  const b = normalize(to).split("/").filter(Boolean);
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  return [...a.slice(shared).map(() => ".."), ...b.slice(shared)].join("/");
}

/** Resolve a reference to a path relative to the flows root, or null. */
export function resolveReference(
  raw: string,
  fromPath: string,
  aliases: Record<string, string>,
): string | null {
  if (raw.startsWith("@")) {
    const body = raw.slice(1);
    const cut = body.indexOf("/");
    if (cut < 0) return null;
    const dir = aliases[body.slice(0, cut)];
    if (dir === undefined) return null;
    return normalize(dir === "." ? body.slice(cut + 1) : `${dir}/${body.slice(cut + 1)}`);
  }
  return normalize(`${dirname(fromPath)}/${raw}`);
}

/** The `@alias/…` form of a path, when a config.yaml alias covers it. */
export function aliasFor(target: string, aliases: Record<string, string>): string | undefined {
  let best: { alias: string; dir: string } | null = null;
  for (const [alias, dir] of Object.entries(aliases)) {
    const prefix = dir === "." ? "" : `${dir}/`;
    if (!target.startsWith(prefix)) continue;
    if (!best || dir.length > best.dir.length) best = { alias, dir };
  }
  if (!best) return undefined;
  const rest = best.dir === "." ? target : target.slice(best.dir.length + 1);
  return `@${best.alias}/${rest}`;
}

/** Render a reference to `target` in the style the call site was already using. */
export function renderReference(
  target: string,
  fromPath: string,
  style: ReferenceStyle,
  aliases: Record<string, string>,
): string {
  if (style === "alias") {
    const aliased = aliasFor(target, aliases);
    if (aliased) return aliased;
  }
  const rel = relative(dirname(fromPath), target);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** The file reference on this line, if it has one. */
export function referenceOnLine(line: string): string | null {
  return REFERENCE_LINE.exec(line)?.[3] ?? null;
}

/** Column range of the reference on this line, so it can be rendered as a link. */
export function referenceSpanOnLine(line: string): { raw: string; from: number; to: number } | null {
  const match = REFERENCE_LINE.exec(line);
  if (!match) return null;
  const from = match[1].length + match[2].length;
  return { raw: match[3], from, to: from + match[3].length };
}
