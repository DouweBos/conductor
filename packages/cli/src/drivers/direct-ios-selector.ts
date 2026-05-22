/**
 * Direct iOS element resolution.
 *
 * For "simple" selectors (a single plain-text/id/query term) the runner can
 * resolve the element natively in one round trip via `/queryElement`, instead
 * of dumping the whole accessibility tree and matching it in JS. This is the
 * single biggest replay speed-up — a full `viewHierarchy` snapshot serialises
 * the entire UI, while a native predicate query touches only the matches.
 *
 * The fast path is deliberately conservative: it only handles selectors whose
 * result is provably identical to the snapshot path (exactly one match), and
 * declines (returns `null`) for anything ambiguous, regex-shaped, positional
 * or stateful so the caller transparently falls back to the snapshot matcher.
 */
import { IOSDriver } from './ios.js';
import { ElementSelector, ResolvedElement } from './element-resolver.js';
import { log } from '../verbose.js';

/** Characters that make a selector value a regex rather than a literal. */
const REGEX_META = /[.*+?^${}()|[\]\\]/;

export interface SimpleIOSSelectorTarget {
  key: 'text' | 'id' | 'query';
  value: string;
}

/**
 * Decide whether `sel` is simple enough to resolve through a direct runner
 * query. Returns the single text/id/query term, or `null` to force the
 * snapshot path.
 *
 * A selector is eligible only when it carries exactly one of text/id/query,
 * the value is a plain literal (no regex metacharacters), and there are no
 * index, relative-position or state constraints — those need the full tree.
 */
export function simpleIOSSelectorTarget(sel: ElementSelector): SimpleIOSSelectorTarget | null {
  if (sel.index !== undefined) return null;
  if (sel.below || sel.above || sel.leftOf || sel.rightOf || sel.containsChild) return null;
  if (
    sel.enabled !== undefined ||
    sel.checked !== undefined ||
    sel.focused !== undefined ||
    sel.selected !== undefined
  ) {
    return null;
  }

  const terms: SimpleIOSSelectorTarget[] = [];
  if (sel.text != null) terms.push({ key: 'text', value: sel.text });
  if (sel.id != null) terms.push({ key: 'id', value: sel.id });
  if (sel.query != null) terms.push({ key: 'query', value: sel.query });
  if (terms.length !== 1) return null;

  const target = terms[0];
  if (!target.value || REGEX_META.test(target.value)) return null;
  return target;
}

/**
 * Build a fast-path resolver for `sel`, or `undefined` when the selector is
 * not simple enough. The returned function resolves the element via the
 * runner; it returns `null` (so the caller falls back to the snapshot path)
 * when the element is absent or the match is ambiguous, and throws only on a
 * transport failure.
 */
export function makeIOSDirectResolver(
  driver: IOSDriver,
  sel: ElementSelector,
  appIds: string[] = []
): (() => Promise<ResolvedElement | null>) | undefined {
  const target = simpleIOSSelectorTarget(sel);
  if (!target) return undefined;

  return async () => {
    const result = await driver.queryElement(target.key, target.value, appIds);
    // matchCount > 1 → ambiguous: let the snapshot matcher apply its
    // deepest-match / prefer-interactive tie-breaking instead of guessing.
    if (!result.found || result.matchCount !== 1 || !result.node) return null;

    const n = result.node;
    const { X, Y, Width, Height } = n.frame;
    log(
      `[iOS] direct query ${target.key}="${target.value}" → ` +
        `text="${n.label || n.title || n.value || n.placeholderValue || ''}" id="${n.identifier}"`
    );
    return {
      centerX: X + Width / 2,
      centerY: Y + Height / 2,
      text: n.label || n.title || n.value || n.placeholderValue || undefined,
      id: n.identifier || undefined,
    };
  };
}
