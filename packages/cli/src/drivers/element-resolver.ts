/**
 * Element resolution and hierarchy formatting for iOS (AXElement) and Android (XML).
 *
 * Mirrors the logic of Maestro's TapOnTool selector matching and ViewHierarchyFormatters
 * inspect output.
 */
import { AXElement } from './ios.js';
import { log } from '../verbose.js';

export interface ElementSelector {
  text?: string; // AND: must match label / title / value / placeholder on iOS; text / content-desc on Android
  id?: string; // AND: must match identifier on iOS; resource-id on Android
  query?: string; // OR: matches text fields OR id — used when a single arg can be either
  index?: number; // 0-based index among all matches
  // State attributes
  enabled?: boolean; // filter by enabled/disabled state
  checked?: boolean; // filter by checked state (checkboxes, toggles)
  focused?: boolean; // filter by input focus state
  selected?: boolean; // filter by selected state (tabs, list items)
  // Relative position — value is a sub-selector identifying the reference element
  below?: ElementSelector;
  above?: ElementSelector;
  leftOf?: ElementSelector;
  rightOf?: ElementSelector;
  containsChild?: ElementSelector;
}

export interface ResolvedElement {
  centerX: number;
  centerY: number;
  text?: string;
  id?: string;
}

// XCUIElementType rawValues that represent interactive controls.
// Mirrors Maestro's clickableFirst() behaviour for iOS, where clickable is not
// exposed in the AXElement — we sort by element type instead.
const IOS_INTERACTIVE_TYPES = new Set([
  9, // Button
  23, // Slider
  40, // Switch
  49, // TextField
  50, // SecureTextField
  54, // Link
  73, // Picker
  74, // PickerWheel
  75, // Cell
  90, // Stepper
  93, // SearchField
]);

// ── iOS: AXElement tree traversal ────────────────────────────────────────────

/** Collect all visible (non-zero-size) leaf/interactive elements from an AXElement tree. */
function collectIOSElements(node: AXElement, results: AXElement[]): void {
  const { Width, Height } = node.frame;
  const visible = Width > 0 && Height > 0;

  if (visible) {
    const hasContent = !!(
      node.label ||
      node.identifier ||
      node.title ||
      node.value ||
      node.placeholderValue
    );
    const isLeaf = !node.children || node.children.length === 0;
    if (hasContent || isLeaf) {
      results.push(node);
    }
  }

  // Always recurse — the root element has a zero-size frame but valid children
  for (const child of node.children ?? []) {
    collectIOSElements(child, results);
  }
}

function iosTextOf(node: AXElement): string {
  return node.label || node.title || node.value || node.placeholderValue || '';
}

function matchesText(candidate: string, query: string): boolean {
  if (!query) return false;
  if (candidate === query) return true;
  if (candidate.toLowerCase() === query.toLowerCase()) return true;
  // fuzzy: .*query.* regex
  try {
    const re = new RegExp(`.*${escapeRegex(query)}.*`, 'i');
    return re.test(candidate);
  } catch {
    return false;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesIOSElement(node: AXElement, sel: ElementSelector): boolean {
  if (sel.query) {
    const text = iosTextOf(node);
    if (!matchesText(text, sel.query) && !matchesText(node.identifier, sel.query)) return false;
  }
  if (sel.text) {
    if (!matchesText(iosTextOf(node), sel.text)) return false;
  }
  if (sel.id) {
    if (!matchesText(node.identifier, sel.id)) return false;
  }
  // State attributes — only match fields that exist on AXElement
  if (sel.enabled !== undefined && node.enabled !== sel.enabled) return false;
  if (sel.selected !== undefined && node.selected !== sel.selected) return false;
  // AXElement.hasFocus maps to the focused selector
  if (sel.focused !== undefined && node.hasFocus !== sel.focused) return false;
  // AXElement has no checked field — sel.checked is silently ignored for iOS
  return true;
}

/**
 * Mirrors Maestro's deepestMatchingElement(): for each branch of the tree,
 * return matching nodes only from the deepest level that has a match.
 * This prevents parent wrapper nodes that inherit their child's accessibility
 * label (common in React Native) from appearing as separate candidates.
 */
function deepestMatchingIOSElements(node: AXElement, pred: (n: AXElement) => boolean): AXElement[] {
  // Recurse into children first — deepest match wins over ancestor
  const childMatches = (node.children ?? []).flatMap((child) =>
    deepestMatchingIOSElements(child, pred)
  );
  if (childMatches.length > 0) return childMatches;

  // No descendant matched — check this node itself
  const { Width, Height } = node.frame;
  if (Width > 0 && Height > 0 && pred(node)) return [node];
  return [];
}

export function findIOSElement(root: AXElement, sel: ElementSelector): ResolvedElement | null {
  // Resolve reference frame for relative-position selectors using the full flat list
  let refFrame: { X: number; Y: number; Width: number; Height: number } | null = null;
  const relSel = sel.below ?? sel.above ?? sel.leftOf ?? sel.rightOf;
  if (relSel) {
    const allNodes: AXElement[] = [];
    collectIOSElements(root, allNodes);
    const ref = allNodes.find((n) => matchesIOSElement(n, relSel));
    if (!ref) return null;
    refFrame = ref.frame;
  }

  // Find deepest matching nodes (eliminates wrapper duplicates)
  let matches = deepestMatchingIOSElements(root, (n) => matchesIOSElement(n, sel));

  if (refFrame) {
    const refBottom = refFrame.Y + refFrame.Height;
    const refRight = refFrame.X + refFrame.Width;
    if (sel.below) {
      matches = matches.filter((n) => n.frame.Y >= refBottom);
    } else if (sel.above) {
      matches = matches.filter((n) => n.frame.Y + n.frame.Height <= refFrame!.Y);
    } else if (sel.leftOf) {
      matches = matches.filter((n) => n.frame.X + n.frame.Width <= refFrame!.X);
    } else if (sel.rightOf) {
      matches = matches.filter((n) => n.frame.X >= refRight);
    }
  }

  if (matches.length === 0) {
    log(`[iOS] no candidates matched selector`, sel);
    return null;
  }

  log(`[iOS] ${matches.length} candidate(s):`);
  matches.forEach((n, i) => {
    const { X, Y, Width, Height } = n.frame;
    const interactive = IOS_INTERACTIVE_TYPES.has(n.elementType);
    log(
      `  [${i}] text="${iosTextOf(n)}" id="${n.identifier}" ` +
        `bounds=[${Math.round(X)},${Math.round(Y)}][${Math.round(X + Width)},${Math.round(Y + Height)}] ` +
        `type=${n.elementType}${interactive ? ' (interactive)' : ''}`
    );
  });

  if (sel.index !== undefined) {
    // Mirror Maestro's INDEX_COMPARATOR: sort top-to-bottom, then left-to-right
    matches = [...matches].sort((a, b) => {
      const dy = a.frame.Y - b.frame.Y;
      return dy !== 0 ? dy : a.frame.X - b.frame.X;
    });
  } else {
    // Prefer interactive element types (approximation of Maestro's clickableFirst for iOS)
    matches = [...matches].sort(
      (a, b) =>
        Number(IOS_INTERACTIVE_TYPES.has(b.elementType)) -
        Number(IOS_INTERACTIVE_TYPES.has(a.elementType))
    );
  }

  const idx = sel.index ?? 0;
  const node = matches[idx < 0 ? matches.length + idx : idx];
  if (!node) {
    log(`[iOS] index ${idx} out of range (${matches.length} candidates)`);
    return null;
  }

  const { X, Y, Width, Height } = node.frame;
  log(
    `[iOS] chose [${idx}] text="${iosTextOf(node)}" id="${node.identifier}" ` +
      `bounds=[${Math.round(X)},${Math.round(Y)}][${Math.round(X + Width)},${Math.round(Y + Height)}] ` +
      `→ tap (${Math.round(X + Width / 2)}, ${Math.round(Y + Height / 2)})`
  );
  return {
    centerX: X + Width / 2,
    centerY: Y + Height / 2,
    text: iosTextOf(node) || undefined,
    id: node.identifier || undefined,
  };
}

// ── Android: XML hierarchy traversal ─────────────────────────────────────────

interface AndroidNode {
  text: string;
  resourceId: string;
  contentDesc: string;
  bounds: { x1: number; y1: number; x2: number; y2: number };
  clickable: boolean;
  enabled: boolean;
  checked: boolean;
  focused: boolean;
  selected: boolean;
  children: AndroidNode[];
  index: number; // position in flat node list
}

function parseBounds(bounds: string): { x1: number; y1: number; x2: number; y2: number } | null {
  const m = bounds.match(/\[(\d+),(\d+)]\[(\d+),(\d+)]/);
  if (!m) return null;
  return { x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4] };
}

// Minimal XML attribute parser — just extract attributes from node strings.
function parseXmlAttributes(str: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w[\w-]*)="([^"]*)"/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

/** Parse Android view hierarchy XML into a flat list of nodes with bounds. */
export function parseAndroidHierarchy(xml: string): AndroidNode[] {
  const nodes: AndroidNode[] = [];
  // Match all <node .../> or <node ...> elements and extract attributes
  const nodeRe = /<node([^>]*?)(?:\/>|>)/g;
  let m;
  while ((m = nodeRe.exec(xml)) !== null) {
    const attrs = parseXmlAttributes(m[1]);
    const bounds = parseBounds(attrs['bounds'] ?? '');
    if (!bounds) continue;
    const { x1, y1, x2, y2 } = bounds;
    if (x2 - x1 <= 0 || y2 - y1 <= 0) continue; // invisible
    nodes.push({
      text: attrs['text'] ?? '',
      resourceId: attrs['resource-id'] ?? '',
      contentDesc: attrs['content-desc'] ?? '',
      bounds,
      clickable: attrs['clickable'] === 'true',
      enabled: attrs['enabled'] === 'true',
      checked: attrs['checked'] === 'true',
      focused: attrs['focused'] === 'true',
      selected: attrs['selected'] === 'true',
      children: [],
      index: nodes.length,
    });
  }
  return nodes;
}

function androidTextOf(n: AndroidNode): string {
  return n.text || n.contentDesc || '';
}

function matchesAndroidNode(n: AndroidNode, sel: ElementSelector): boolean {
  if (sel.query) {
    if (!matchesText(androidTextOf(n), sel.query) && !matchesText(n.resourceId, sel.query))
      return false;
  }
  if (sel.text) {
    if (!matchesText(androidTextOf(n), sel.text)) return false;
  }
  if (sel.id) {
    if (!matchesText(n.resourceId, sel.id)) return false;
  }
  if (sel.enabled !== undefined && n.enabled !== sel.enabled) return false;
  if (sel.checked !== undefined && n.checked !== sel.checked) return false;
  if (sel.focused !== undefined && n.focused !== sel.focused) return false;
  if (sel.selected !== undefined && n.selected !== sel.selected) return false;
  return true;
}

export function findAndroidElement(xml: string, sel: ElementSelector): ResolvedElement | null {
  const nodes = parseAndroidHierarchy(xml);

  // Find reference element for relative selectors
  let refBounds: { x1: number; y1: number; x2: number; y2: number } | null = null;
  const relSel = sel.below ?? sel.above ?? sel.leftOf ?? sel.rightOf;
  if (relSel) {
    const refMatches = nodes.filter((n) => matchesAndroidNode(n, relSel));
    if (refMatches.length === 0) return null;
    const ref = refMatches[0];
    refBounds = ref.bounds;
  }

  let matches = nodes.filter((n) => matchesAndroidNode(n, sel));

  // Apply relative position filter
  if (refBounds) {
    if (sel.below) {
      matches = matches.filter((n) => n.bounds.y1 >= refBounds!.y2);
    } else if (sel.above) {
      matches = matches.filter((n) => n.bounds.y2 <= refBounds!.y1);
    } else if (sel.leftOf) {
      matches = matches.filter((n) => n.bounds.x2 <= refBounds!.x1);
    } else if (sel.rightOf) {
      matches = matches.filter((n) => n.bounds.x1 >= refBounds!.x2);
    }
  }

  // containsChild: not easily supported in the flat model — no-op for now
  // (sel.containsChild would require tree structure, which is not preserved in the flat list)

  if (matches.length === 0) {
    log(`[Android] no candidates matched selector`, sel);
    return null;
  }

  log(`[Android] ${matches.length} candidate(s) before sort/index:`);
  matches.forEach((n, i) => {
    const { x1, y1, x2, y2 } = n.bounds;
    log(
      `  [${i}] text="${androidTextOf(n)}" id="${n.resourceId}" ` +
        `bounds=[${x1},${y1}][${x2},${y2}]` +
        `${n.clickable ? ' (clickable)' : ''}`
    );
  });

  // Mirror Maestro's clickableFirst(): when no index is specified, prefer
  // clickable nodes so a text label shared by a Button and a plain TextView
  // resolves to the button, matching Maestro's GraalVM behaviour.
  if (sel.index === undefined) {
    matches = [...matches].sort((a, b) => Number(b.clickable) - Number(a.clickable));
  }

  const idx = sel.index ?? 0;
  const node = matches[idx < 0 ? matches.length + idx : idx];
  if (!node) {
    log(`[Android] index ${idx} out of range (${matches.length} candidates)`);
    return null;
  }

  const { x1, y1, x2, y2 } = node.bounds;
  log(
    `[Android] chose [${idx}] text="${androidTextOf(node)}" id="${node.resourceId}" ` +
      `bounds=[${x1},${y1}][${x2},${y2}] ` +
      `→ tap (${Math.round((x1 + x2) / 2)}, ${Math.round((y1 + y2) / 2)})`
  );
  return {
    centerX: (x1 + x2) / 2,
    centerY: (y1 + y2) / 2,
    text: androidTextOf(node) || undefined,
    id: node.resourceId || undefined,
  };
}

// ── Inspect: LLM-optimized output ────────────────────────────────────────────

/**
 * Filter iOS hierarchy: remove zero-size nodes and nodes with no meaningful content.
 * Returns a flattened list of lines suitable for agent consumption.
 */
export function inspectIOSToText(root: AXElement): string {
  const lines: string[] = [];
  visitIOS(root, lines, 0);
  return lines.join('\n');
}

function visitIOS(node: AXElement, lines: string[], depth: number): void {
  const { X, Y, Width, Height } = node.frame;
  const visible = Width > 0 && Height > 0;

  if (visible) {
    const text = iosTextOf(node);
    const id = node.identifier;
    const parts: string[] = [];
    if (text) parts.push(`text="${text}"`);
    if (id) parts.push(`id="${id}"`);
    parts.push(
      `bounds=[${Math.round(X)},${Math.round(Y)}][${Math.round(X + Width)},${Math.round(Y + Height)}]`
    );
    if (!node.enabled) parts.push('disabled');

    if (parts.length > 1 || !node.children?.length) {
      lines.push(`${'  '.repeat(depth)}${parts.join(' ')}`);
    }
  }

  // Always recurse — the root element has a zero-size frame but valid children
  for (const child of node.children ?? []) {
    visitIOS(child, lines, depth + 1);
  }
}

/**
 * Format Android hierarchy XML into LLM-optimized text.
 */
export function inspectAndroidToText(xml: string): string {
  const nodes = parseAndroidHierarchy(xml);
  return nodes
    .filter((n) => androidTextOf(n) || n.resourceId)
    .map((n) => {
      const { x1, y1, x2, y2 } = n.bounds;
      const parts: string[] = [];
      const t = androidTextOf(n);
      if (t) parts.push(`text="${t}"`);
      if (n.resourceId) parts.push(`id="${n.resourceId}"`);
      parts.push(`bounds=[${x1},${y1}][${x2},${y2}]`);
      if (!n.enabled) parts.push('disabled');
      return parts.join(' ');
    })
    .join('\n');
}
