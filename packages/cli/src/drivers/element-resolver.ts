/**
 * Element resolution and hierarchy formatting for iOS (AXElement), Android (XML), and Web (ARIA).
 *
 * Text/id selectors use full-string regex matching (`toRegexSafe` + anchored match), multiple
 * text-bearing attributes per platform, and id matching on the full id or the segment after the
 * last `/`. This aligns with YAML flow semantics used by `run-flow`.
 */
import { AXElement } from './ios.js';
import { WebElement, WebViewHierarchy } from './web.js';
import { log } from '../verbose.js';

export interface ElementSelector {
  text?: string; // AND: full-string regex on platform text fields (see matchesIOSElement)
  id?: string; // AND: full-string regex on id, or on segment after last '/'
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
// Approximates “prefer clickable” when sorting, since AXElement does not expose clickable.
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

function iosTextMatchFields(node: AXElement): (string | undefined)[] {
  return [node.label, node.title, node.value, node.placeholderValue];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toRegexSafe(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'ims');
  } catch {
    return new RegExp(escapeRegex(pattern), 'ims');
  }
}

function regexMatchesEntireString(regex: RegExp, value: string): boolean {
  const anchored = new RegExp(`^(?:${regex.source})$`, regex.flags);
  return anchored.test(value);
}

/** Entire attribute value must match the pattern; newlines are normalized to spaces for a second pass. */
function matchPatternAgainstTextField(pattern: string, value: string | null | undefined): boolean {
  if (value == null || value === '') return false;
  const re = toRegexSafe(pattern);
  const stripped = value.replace(/\n/g, ' ');
  return (
    regexMatchesEntireString(re, value) ||
    pattern === value ||
    regexMatchesEntireString(re, stripped) ||
    pattern === stripped
  );
}

function matchPatternAgainstAnyTextField(
  pattern: string,
  fields: (string | null | undefined)[]
): boolean {
  for (const f of fields) {
    if (f != null && f !== '' && matchPatternAgainstTextField(pattern, f)) return true;
  }
  return false;
}

function substringAfterLastSlash(s: string): string {
  const i = s.lastIndexOf('/');
  return i === -1 ? s : s.slice(i + 1);
}

function matchPatternAgainstElementId(pattern: string, value: string | null | undefined): boolean {
  if (value == null || value === '') return false;
  return (
    matchPatternAgainstTextField(pattern, value) ||
    matchPatternAgainstTextField(pattern, substringAfterLastSlash(value))
  );
}

function matchesIOSElement(node: AXElement, sel: ElementSelector): boolean {
  if (sel.query) {
    const textOk = matchPatternAgainstAnyTextField(sel.query, iosTextMatchFields(node));
    const idOk = matchPatternAgainstElementId(sel.query, node.identifier);
    if (!textOk && !idOk) return false;
  }
  if (sel.text) {
    if (!matchPatternAgainstAnyTextField(sel.text, iosTextMatchFields(node))) return false;
  }
  if (sel.id) {
    if (!matchPatternAgainstElementId(sel.id, node.identifier)) return false;
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
 * Deepest match per branch: prefer matches in descendants so parent wrappers that only
 * duplicate a child label (e.g. React Native) do not appear as duplicate tap targets.
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
    // Sort top-to-bottom, then left-to-right when index is set
    matches = [...matches].sort((a, b) => {
      const dy = a.frame.Y - b.frame.Y;
      return dy !== 0 ? dy : a.frame.X - b.frame.X;
    });
  } else {
    // Prefer interactive element types when no explicit index
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
  className: string;
  packageName: string;
  bounds: { x1: number; y1: number; x2: number; y2: number };
  clickable: boolean;
  enabled: boolean;
  checked: boolean;
  focused: boolean;
  focusable: boolean;
  selected: boolean;
  checkable: boolean;
  longClickable: boolean;
  scrollable: boolean;
  password: boolean;
  visibleToUser: boolean;
  hintText: string;
  error: string;
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
      className: attrs['class'] ?? '',
      packageName: attrs['package'] ?? '',
      bounds,
      clickable: attrs['clickable'] === 'true',
      enabled: attrs['enabled'] === 'true',
      checked: attrs['checked'] === 'true',
      focused: attrs['focused'] === 'true',
      focusable: attrs['focusable'] === 'true',
      selected: attrs['selected'] === 'true',
      checkable: attrs['checkable'] === 'true',
      longClickable: attrs['long-clickable'] === 'true',
      scrollable: attrs['scrollable'] === 'true',
      password: attrs['password'] === 'true',
      visibleToUser: attrs['visible-to-user'] === 'true',
      hintText: attrs['hintText'] ?? '',
      error: attrs['error'] ?? '',
      children: [],
      index: nodes.length,
    });
  }
  return nodes;
}

function androidTextOf(n: AndroidNode): string {
  return n.text || n.contentDesc || '';
}

function androidTextMatchFields(n: AndroidNode): (string | undefined)[] {
  return [n.text, n.contentDesc, n.hintText];
}

function matchesAndroidNode(n: AndroidNode, sel: ElementSelector): boolean {
  if (sel.query) {
    const textOk = matchPatternAgainstAnyTextField(sel.query, androidTextMatchFields(n));
    const idOk = matchPatternAgainstElementId(sel.query, n.resourceId);
    if (!textOk && !idOk) return false;
  }
  if (sel.text) {
    if (!matchPatternAgainstAnyTextField(sel.text, androidTextMatchFields(n))) return false;
  }
  if (sel.id) {
    if (!matchPatternAgainstElementId(sel.id, n.resourceId)) return false;
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

  // When no index is specified, prefer clickable nodes so shared labels resolve to controls.
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

// ── Web: ARIA snapshot tree traversal ───────────────────────────────────────

// ARIA roles that represent interactive controls — mirrors IOS_INTERACTIVE_TYPES
const WEB_INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
]);

/** Collect all visible (has bounds) leaf/interactive elements from a WebElement tree. */
function collectWebElements(nodes: WebElement[], results: WebElement[]): void {
  for (const node of nodes) {
    const visible = node.bounds && node.bounds.width > 0 && node.bounds.height > 0;

    if (visible) {
      const hasContent = !!(node.name || node.ref);
      const isLeaf = !node.children || node.children.length === 0;
      if (hasContent || isLeaf) {
        results.push(node);
      }
    }

    if (node.children) {
      collectWebElements(node.children, results);
    }
  }
}

function matchesWebElement(node: WebElement, sel: ElementSelector): boolean {
  if (sel.query) {
    const textOk = matchPatternAgainstAnyTextField(sel.query, [node.name]);
    const idOk = matchPatternAgainstElementId(sel.query, node.ref);
    if (!textOk && !idOk) return false;
  }
  if (sel.text) {
    if (!matchPatternAgainstAnyTextField(sel.text, [node.name])) return false;
  }
  if (sel.id) {
    if (!matchPatternAgainstElementId(sel.id, node.ref)) return false;
  }
  if (sel.enabled !== undefined && node.enabled !== sel.enabled) return false;
  if (sel.checked !== undefined && node.checked !== sel.checked) return false;
  if (sel.focused !== undefined && node.focused !== sel.focused) return false;
  if (sel.selected !== undefined && node.selected !== sel.selected) return false;
  return true;
}

/**
 * Deepest matching elements — same logic as iOS to avoid parent wrapper duplicates.
 */
function deepestMatchingWebElements(
  nodes: WebElement[],
  pred: (n: WebElement) => boolean
): WebElement[] {
  const results: WebElement[] = [];
  for (const node of nodes) {
    const childMatches = node.children ? deepestMatchingWebElements(node.children, pred) : [];
    if (childMatches.length > 0) {
      results.push(...childMatches);
    } else if (node.bounds && node.bounds.width > 0 && node.bounds.height > 0 && pred(node)) {
      results.push(node);
    }
  }
  return results;
}

export function findWebElement(
  hierarchy: WebViewHierarchy,
  sel: ElementSelector
): ResolvedElement | null {
  // Resolve reference frame for relative-position selectors
  let refBounds: { x: number; y: number; width: number; height: number } | null = null;
  const relSel = sel.below ?? sel.above ?? sel.leftOf ?? sel.rightOf;
  if (relSel) {
    const allNodes: WebElement[] = [];
    collectWebElements(hierarchy.elements, allNodes);
    const ref = allNodes.find((n) => matchesWebElement(n, relSel));
    if (!ref?.bounds) return null;
    refBounds = ref.bounds;
  }

  // Find deepest matching nodes
  let matches = deepestMatchingWebElements(hierarchy.elements, (n) => matchesWebElement(n, sel));

  // Apply relative position filter
  if (refBounds) {
    const refBottom = refBounds.y + refBounds.height;
    const refRight = refBounds.x + refBounds.width;
    if (sel.below) {
      matches = matches.filter((n) => n.bounds && n.bounds.y >= refBottom);
    } else if (sel.above) {
      matches = matches.filter((n) => n.bounds && n.bounds.y + n.bounds.height <= refBounds!.y);
    } else if (sel.leftOf) {
      matches = matches.filter((n) => n.bounds && n.bounds.x + n.bounds.width <= refBounds!.x);
    } else if (sel.rightOf) {
      matches = matches.filter((n) => n.bounds && n.bounds.x >= refRight);
    }
  }

  // Filter to elements that have bounding boxes (visible and measurable)
  matches = matches.filter((n) => n.bounds && n.bounds.width > 0 && n.bounds.height > 0);

  if (matches.length === 0) {
    log(`[Web] no candidates matched selector`, sel);
    return null;
  }

  log(`[Web] ${matches.length} candidate(s):`);
  matches.forEach((n, i) => {
    const b = n.bounds!;
    const interactive = WEB_INTERACTIVE_ROLES.has(n.role);
    log(
      `  [${i}] text="${n.name}" ref="${n.ref}" role="${n.role}" ` +
        `bounds=[${Math.round(b.x)},${Math.round(b.y)}][${Math.round(b.x + b.width)},${Math.round(b.y + b.height)}]` +
        `${interactive ? ' (interactive)' : ''}`
    );
  });

  if (sel.index !== undefined) {
    // Sort top-to-bottom, then left-to-right
    matches = [...matches].sort((a, b) => {
      const dy = a.bounds!.y - b.bounds!.y;
      return dy !== 0 ? dy : a.bounds!.x - b.bounds!.x;
    });
  } else {
    // Prefer interactive roles
    matches = [...matches].sort(
      (a, b) =>
        Number(WEB_INTERACTIVE_ROLES.has(b.role)) - Number(WEB_INTERACTIVE_ROLES.has(a.role))
    );
  }

  const idx = sel.index ?? 0;
  const node = matches[idx < 0 ? matches.length + idx : idx];
  if (!node) {
    log(`[Web] index ${idx} out of range (${matches.length} candidates)`);
    return null;
  }

  const b = node.bounds!;
  log(
    `[Web] chose [${idx}] text="${node.name}" ref="${node.ref}" role="${node.role}" ` +
      `bounds=[${Math.round(b.x)},${Math.round(b.y)}][${Math.round(b.x + b.width)},${Math.round(b.y + b.height)}] ` +
      `→ tap (${Math.round(b.x + b.width / 2)}, ${Math.round(b.y + b.height / 2)})`
  );
  return {
    centerX: b.x + b.width / 2,
    centerY: b.y + b.height / 2,
    text: node.name || undefined,
    id: node.ref || undefined,
  };
}

/**
 * Format web ARIA hierarchy into LLM-optimized text.
 */
export function inspectWebToText(hierarchy: WebViewHierarchy): string {
  const lines: string[] = [];
  visitWeb(hierarchy.elements, lines, 0);
  return lines.join('\n');
}

function visitWeb(nodes: WebElement[], lines: string[], depth: number): void {
  for (const node of nodes) {
    const parts: string[] = [];
    parts.push(node.role);
    if (node.name) parts.push(`"${node.name}"`);
    if (node.ref) parts.push(`ref=${node.ref}`);
    if (node.bounds) {
      const b = node.bounds;
      parts.push(
        `bounds=[${Math.round(b.x)},${Math.round(b.y)}][${Math.round(b.x + b.width)},${Math.round(b.y + b.height)}]`
      );
    }
    if (!node.enabled) parts.push('disabled');

    // Only output nodes that have content
    if (node.name || node.ref || (node.bounds && (!node.children || node.children.length === 0))) {
      lines.push(`${'  '.repeat(depth)}${parts.join(' ')}`);
    }

    if (node.children) {
      visitWeb(node.children, lines, depth + 1);
    }
  }
}
