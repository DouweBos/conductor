/**
 * Target-label helpers, kept free of Electron imports so they can be unit
 * tested — everything else in this folder reaches for `BrowserWindow`.
 */

/** Filesystem-safe directory name for a target label. */
export function slugForLabel(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "target"
  );
}

/**
 * The first pair of labels that would land in the same directory, if any.
 *
 * Distinct labels can still collide once slugged ("tvOS" and "TV OS" both
 * become "tv-os"), which would have two targets recording over each other and
 * the matrix comparing one build against itself.
 */
export function slugCollision(labels: string[]): { a: string; b: string; slug: string } | null {
  const seen = new Map<string, string>();
  for (const label of labels) {
    const slug = slugForLabel(label);
    const owner = seen.get(slug);
    if (owner) return { a: owner, b: label, slug };
    seen.set(slug, label);
  }
  return null;
}
