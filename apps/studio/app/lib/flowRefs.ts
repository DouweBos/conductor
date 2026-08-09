import path from "node:path";

/**
 * How one flow names another. Shared by the main process (rename, usages,
 * linting) and the renderer (go-to-definition, completion) so both agree on
 * exactly what a `runFlow: "@pages/x.yaml"` points at.
 *
 * Alias semantics mirror conductor's `resolvePath`: `@name/rest` maps `name`
 * through `paths:` in the flows directory's config.yaml.
 */

export type ReferenceStyle = "alias" | "relative";

/** Lines that name a file: `runFlow: x`, `runScript: x`, `file: x`. */
export const REFERENCE_LINE =
  /^(\s*-?\s*(?:runFlow|runScript|file)\s*:\s*)(['"]?)([@\w./-]+\.(?:ya?ml|js|ts))\2/;

function normalize(target: string): string {
  return path.posix.normalize(target).replace(/^\.\//, "");
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
  return normalize(path.posix.join(path.posix.dirname(fromPath), raw));
}

/** Render a reference to `target` in the style the call site was already using. */
export function renderReference(
  target: string,
  fromPath: string,
  style: ReferenceStyle,
  aliases: Record<string, string>,
): string {
  if (style === "alias") {
    let best: { alias: string; dir: string } | null = null;
    for (const [alias, dir] of Object.entries(aliases)) {
      const prefix = dir === "." ? "" : `${dir}/`;
      if (!target.startsWith(prefix)) continue;
      if (!best || dir.length > best.dir.length) best = { alias, dir };
    }
    if (best) {
      const rest = best.dir === "." ? target : target.slice(best.dir.length + 1);
      return `@${best.alias}/${rest}`;
    }
  }
  const rel = path.posix.relative(path.posix.dirname(fromPath), target);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** The file reference on this line, if it has one. */
export function referenceOnLine(line: string): string | null {
  return REFERENCE_LINE.exec(line)?.[3] ?? null;
}
