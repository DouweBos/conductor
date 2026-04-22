/**
 * Accessibility enrichment and snapshot generation.
 *
 * Given a platform-native view hierarchy, produces:
 *   1. An a11y-enriched hierarchy (same shape as the source, with added a11y fields)
 *   2. A flat a11ySnapshot array in screen-reader navigation order
 *
 * Shared shapes are used across iOS / Android / Web so Argus only has to consume one
 * format. Per-platform specifics live in the builder functions.
 */
import { AXElement } from './ios.js';
import { WebElement, WebViewHierarchy } from './web.js';
import { parseAndroidHierarchy } from './element-resolver.js';

export interface A11yFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface A11yState {
  enabled: boolean;
  selected: boolean;
  focused: boolean;
  checked?: boolean;
  disabled?: boolean;
}

export interface A11ySnapshotEntry {
  nodeId: string;
  order: number;
  frame: A11yFrame;
  label: string;
  hint: string;
  role: string;
  traits: string[];
  announcement: string;
  value: string;
  state: A11yState;
}

export interface A11yBuildResult<H> {
  hierarchy: H;
  a11ySnapshot: A11ySnapshotEntry[];
}

// ── iOS ──────────────────────────────────────────────────────────────────────

/** XCUIElementType raw values → trait/role strings. Incomplete by design: only
 *  the element types that map to user-facing roles are listed; others fall back
 *  to an empty traits array and an empty role string. */
const IOS_TYPE_TO_TRAIT: Record<number, string> = {
  3: 'application',
  4: 'window',
  8: 'image',
  9: 'button',
  23: 'adjustable',
  40: 'switch',
  48: 'staticText',
  49: 'textField',
  50: 'secureTextField',
  54: 'link',
  70: 'table',
  73: 'picker',
  74: 'pickerWheel',
  75: 'cell',
  90: 'stepper',
  93: 'searchField',
};

export interface IOSA11yNode extends AXElement {
  nodeId: string;
  accessibilityOrder: number | null;
  traits: string[];
  isAccessibilityElement: boolean;
  accessibilityIdentifier?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityValue?: string;
  announcement?: string;
  children?: IOSA11yNode[];
}

function iosTraitsFor(node: AXElement): string[] {
  const out: string[] = [];
  const base = IOS_TYPE_TO_TRAIT[node.elementType];
  if (base) out.push(base);
  if (node.selected) out.push('selected');
  if (!node.enabled) out.push('disabled');
  if (node.hasFocus) out.push('focused');
  return out;
}

function isIOSA11yElement(node: AXElement): boolean {
  // VoiceOver considers an element "accessible" if it has a label or a known interactive type.
  // AXElement doesn't expose isAccessibilityElement directly; this is a documented approximation.
  const hasText = !!(node.label || node.title || node.value || node.placeholderValue);
  const hasTrait = !!IOS_TYPE_TO_TRAIT[node.elementType];
  const hasFrame = node.frame.Width > 0 && node.frame.Height > 0;
  return hasFrame && (hasText || hasTrait);
}

/** iOS announcement: `[label], [traits], [value], [hint]` — commas between parts. */
export function composeIOSAnnouncement(
  label: string,
  traits: string[],
  value: string,
  hint: string
): string {
  const parts: string[] = [];
  if (label) parts.push(label);
  const announceableTraits = traits.filter(
    (t) => t !== 'staticText' && t !== 'window' && t !== 'application'
  );
  if (announceableTraits.length) parts.push(announceableTraits.join(', '));
  if (value && value !== label) parts.push(value);
  if (hint) parts.push(hint);
  return parts.join(', ');
}

export function buildIOSA11y(root: AXElement): A11yBuildResult<IOSA11yNode> {
  const snapshot: A11ySnapshotEntry[] = [];
  let order = 0;

  function walk(node: AXElement, path: string): IOSA11yNode {
    const traits = iosTraitsFor(node);
    const isA11y = isIOSA11yElement(node);
    const label = node.label || node.title || '';
    const value = node.value || node.placeholderValue || '';
    const hint = node.hint || '';
    const announcement = isA11y ? composeIOSAnnouncement(label, traits, value, hint) : '';

    let accessibilityOrder: number | null = null;
    if (isA11y) {
      accessibilityOrder = order++;
      snapshot.push({
        nodeId: path,
        order: accessibilityOrder,
        frame: {
          x: node.frame.X,
          y: node.frame.Y,
          w: node.frame.Width,
          h: node.frame.Height,
        },
        label,
        hint,
        role: traits[0] ?? '',
        traits,
        announcement,
        value,
        state: {
          enabled: node.enabled,
          selected: node.selected,
          focused: node.hasFocus,
        },
      });
    }

    const children: IOSA11yNode[] = (node.children ?? []).map((c, i) =>
      walk(c, path === '' ? String(i) : `${path}.${i}`)
    );

    const enriched: IOSA11yNode = {
      ...node,
      nodeId: path,
      accessibilityOrder,
      traits,
      isAccessibilityElement: isA11y,
      accessibilityIdentifier: node.identifier,
      accessibilityLabel: label || undefined,
      accessibilityHint: hint || undefined,
      accessibilityValue: value || undefined,
      announcement: announcement || undefined,
      children: children.length ? children : undefined,
    };
    return enriched;
  }

  const hierarchy = walk(root, '0');
  return { hierarchy, a11ySnapshot: snapshot };
}

// ── Android ──────────────────────────────────────────────────────────────────

export interface AndroidA11yNode {
  nodeId: string;
  accessibilityOrder: number | null;
  class: string;
  resourceId: string;
  text: string;
  contentDescription: string;
  hintText: string;
  roleDescription: string;
  role: string;
  importantForAccessibility: string;
  screenReaderFocusable: boolean;
  bounds: { x1: number; y1: number; x2: number; y2: number };
  state: A11yState;
  announcement: string;
  children?: AndroidA11yNode[];
}

// Android className → semantic role. Matches AccessibilityNodeInfoCompat defaults.
const ANDROID_CLASS_ROLE: Array<[RegExp, string]> = [
  [/Button$/, 'button'],
  [/ImageButton$/, 'button'],
  [/EditText$/, 'textField'],
  [/CheckBox$/, 'checkbox'],
  [/Switch$/, 'switch'],
  [/ToggleButton$/, 'switch'],
  [/RadioButton$/, 'radio'],
  [/Spinner$/, 'dropdown'],
  [/SeekBar$/, 'adjustable'],
  [/ProgressBar$/, 'progressIndicator'],
  [/TextView$/, 'staticText'],
  [/ImageView$/, 'image'],
  [/WebView$/, 'webView'],
];

function androidRoleFor(className: string): string {
  for (const [re, role] of ANDROID_CLASS_ROLE) {
    if (re.test(className)) return role;
  }
  return '';
}

/** Android announcement: `[contentDescription || text], [role], [state], [hint]`. */
export function composeAndroidAnnouncement(
  text: string,
  contentDescription: string,
  role: string,
  stateParts: string[],
  hint: string
): string {
  const parts: string[] = [];
  const spoken = contentDescription || text;
  if (spoken) parts.push(spoken);
  if (role) parts.push(role);
  if (stateParts.length) parts.push(stateParts.join(', '));
  if (hint) parts.push(hint);
  return parts.join(', ');
}

interface _AndroidRawNode {
  text: string;
  resourceId: string;
  contentDesc: string;
  className: string;
  hintText: string;
  bounds: { x1: number; y1: number; x2: number; y2: number };
  clickable: boolean;
  focusable: boolean;
  enabled: boolean;
  checked: boolean;
  checkable: boolean;
  focused: boolean;
  selected: boolean;
  visibleToUser: boolean;
}

/**
 * Parse Android XML while preserving nesting — parseAndroidHierarchy returns a flat list,
 * but we need tree structure for stable nodeId paths. We re-walk the XML here with a small
 * state machine (open-tag depth) to reconstruct parent/child relationships.
 */
function parseAndroidTree(
  xml: string
): _AndroidRawNode[] & { childrenOf: Map<number, number[]>; roots: number[] } {
  const flat = parseAndroidHierarchy(xml);
  // Parent index per node, computed from ordered XML scan.
  const openStack: number[] = [];
  const parentOf = new Array<number>(flat.length).fill(-1);
  // Regex that walks open/close tags in order.
  const tokenRe = /<node\b[^>]*?(\/?)>|<\/node>/g;
  let idx = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(xml)) !== null) {
    const tag = m[0];
    if (tag === '</node>') {
      openStack.pop();
      continue;
    }
    const selfClosing = m[1] === '/';
    // Does this node have a valid bounds? Only those appear in `flat`.
    const boundsMatch = /\bbounds="(\[[^"]+\])"/.exec(tag);
    const hasValidBounds =
      boundsMatch &&
      /\[(\d+),(\d+)]\[(\d+),(\d+)]/.test(boundsMatch[1]) &&
      (() => {
        const [, x1, y1, x2, y2] = /\[(\d+),(\d+)]\[(\d+),(\d+)]/.exec(boundsMatch[1])!;
        return +x2 - +x1 > 0 && +y2 - +y1 > 0;
      })();
    if (hasValidBounds) {
      parentOf[idx] = openStack.length ? openStack[openStack.length - 1] : -1;
      if (!selfClosing) openStack.push(idx);
      idx++;
    } else if (!selfClosing) {
      // Non-visible container: push a sentinel so close tags still pop correctly.
      openStack.push(-1);
    }
  }

  const childrenOf = new Map<number, number[]>();
  const roots: number[] = [];
  parentOf.forEach((p, i) => {
    if (p === -1) roots.push(i);
    else {
      const arr = childrenOf.get(p) ?? [];
      arr.push(i);
      childrenOf.set(p, arr);
    }
  });

  const result = flat.map((n) => ({
    text: n.text,
    resourceId: n.resourceId,
    contentDesc: n.contentDesc,
    className: n.className,
    hintText: n.hintText,
    bounds: n.bounds,
    clickable: n.clickable,
    focusable: n.focusable,
    enabled: n.enabled,
    checked: n.checked,
    checkable: n.checkable,
    focused: n.focused,
    selected: n.selected,
    visibleToUser: n.visibleToUser,
  })) as _AndroidRawNode[] & { childrenOf: Map<number, number[]>; roots: number[] };
  result.childrenOf = childrenOf;
  result.roots = roots;
  return result;
}

export function buildAndroidA11y(xml: string): A11yBuildResult<AndroidA11yNode[]> {
  const tree = parseAndroidTree(xml);
  const snapshot: A11ySnapshotEntry[] = [];

  // Phase 1: tag each node with metadata + decide "hasAnnouncedDescendant" (post-order).
  interface Meta {
    role: string;
    screenReaderFocusable: boolean;
    importantForAccessibility: string;
    announcement: string;
    stateParts: string[];
    wouldAnnounce: boolean; // meets the per-node criteria before merge-skip
    hasAnnouncedDescendant: boolean;
  }
  const meta = new Array<Meta>(tree.length);
  const computeMeta = (rawIdx: number): Meta => {
    const n = tree[rawIdx];
    const role = androidRoleFor(n.className);
    const screenReaderFocusable = n.focusable && (!!n.text || !!n.contentDesc);
    const importantForAccessibility = screenReaderFocusable ? 'yes' : 'auto';
    const stateParts: string[] = [];
    if (n.checkable) stateParts.push(n.checked ? 'checked' : 'not checked');
    if (n.selected) stateParts.push('selected');
    if (!n.enabled) stateParts.push('disabled');
    const announcement = composeAndroidAnnouncement(
      n.text,
      n.contentDesc,
      role,
      stateParts,
      n.hintText
    );
    // importantForAccessibility is inferred as 'yes' or 'auto' here (uiautomator
    // dumps omit 'no' nodes). The 'no' case is kept as a documented future extension.
    const wouldAnnounce = n.visibleToUser && (!!n.text || !!n.contentDesc || screenReaderFocusable);
    return {
      role,
      screenReaderFocusable,
      importantForAccessibility,
      announcement,
      stateParts,
      wouldAnnounce,
      hasAnnouncedDescendant: false,
    };
  };

  // Post-order pass to fill hasAnnouncedDescendant.
  const postOrder = (rawIdx: number): boolean => {
    meta[rawIdx] = computeMeta(rawIdx);
    let anyChild = false;
    for (const c of tree.childrenOf.get(rawIdx) ?? []) {
      const childHasAnnounced = postOrder(c);
      if (childHasAnnounced || meta[c].wouldAnnounce) anyChild = true;
    }
    meta[rawIdx].hasAnnouncedDescendant = anyChild;
    return anyChild;
  };
  for (const r of tree.roots) postOrder(r);

  // Phase 2: pre-order walk to emit snapshot entries + build enriched tree.
  let order = 0;
  const walk = (rawIdx: number, path: string): AndroidA11yNode => {
    const n = tree[rawIdx];
    const m = meta[rawIdx];

    const inOrder = m.wouldAnnounce && !m.hasAnnouncedDescendant;
    let accessibilityOrder: number | null = null;
    if (inOrder) {
      accessibilityOrder = order++;
      snapshot.push({
        nodeId: path,
        order: accessibilityOrder,
        frame: {
          x: n.bounds.x1,
          y: n.bounds.y1,
          w: n.bounds.x2 - n.bounds.x1,
          h: n.bounds.y2 - n.bounds.y1,
        },
        label: n.contentDesc || n.text,
        hint: n.hintText,
        role: m.role,
        traits: m.role ? [m.role] : [],
        announcement: m.announcement,
        value: '',
        state: {
          enabled: n.enabled,
          selected: n.selected,
          focused: n.focused,
          checked: n.checkable ? n.checked : undefined,
        },
      });
    }

    const childIndices = tree.childrenOf.get(rawIdx) ?? [];
    const kids = childIndices.map((i, ci) => walk(i, `${path}.${ci}`));

    return {
      nodeId: path,
      accessibilityOrder,
      class: n.className,
      resourceId: n.resourceId,
      text: n.text,
      contentDescription: n.contentDesc,
      hintText: n.hintText,
      roleDescription: m.role,
      role: m.role,
      importantForAccessibility: m.importantForAccessibility,
      screenReaderFocusable: m.screenReaderFocusable,
      bounds: n.bounds,
      state: {
        enabled: n.enabled,
        selected: n.selected,
        focused: n.focused,
        checked: n.checkable ? n.checked : undefined,
      },
      announcement: m.announcement,
      children: kids.length ? kids : undefined,
    };
  };

  const hierarchy = tree.roots.map((r, i) => walk(r, String(i)));
  return { hierarchy, a11ySnapshot: snapshot };
}

// ── Web ──────────────────────────────────────────────────────────────────────

export interface WebA11yNode extends WebElement {
  nodeId: string;
  accessibilityOrder: number | null;
  accessibleName: string;
  ariaLabel: string;
  ariaDescription: string;
  focusable: boolean;
  announcement: string;
  children?: WebA11yNode[];
}

const WEB_FOCUSABLE_ROLES = new Set([
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
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
]);

function isWebFocusable(node: WebElement): boolean {
  return WEB_FOCUSABLE_ROLES.has(node.role);
}

/** Web announcement: `[accessibleName], [role], [state]` — screen readers read role after name. */
export function composeWebAnnouncement(name: string, role: string, stateParts: string[]): string {
  const parts: string[] = [];
  if (name) parts.push(name);
  if (role && role !== 'generic' && role !== 'none') parts.push(role);
  if (stateParts.length) parts.push(stateParts.join(', '));
  return parts.join(', ');
}

export function buildWebA11y(hierarchy: WebViewHierarchy): A11yBuildResult<WebA11yNode[]> {
  const snapshot: A11ySnapshotEntry[] = [];
  let order = 0;

  function walk(nodes: WebElement[], basePath: string): WebA11yNode[] {
    return nodes.map((n, i) => {
      const path = basePath === '' ? String(i) : `${basePath}.${i}`;
      const focusable = isWebFocusable(n);
      const stateParts: string[] = [];
      if (n.checked) stateParts.push('checked');
      if (n.selected) stateParts.push('selected');
      if (!n.enabled) stateParts.push('disabled');
      const announcement = composeWebAnnouncement(n.name, n.role, stateParts);

      const kids = n.children ? walk(n.children, path) : undefined;

      let accessibilityOrder: number | null = null;
      if (focusable && n.bounds && n.bounds.width > 0 && n.bounds.height > 0) {
        accessibilityOrder = order++;
        snapshot.push({
          nodeId: path,
          order: accessibilityOrder,
          frame: { x: n.bounds.x, y: n.bounds.y, w: n.bounds.width, h: n.bounds.height },
          label: n.name,
          hint: '',
          role: n.role,
          traits: n.role ? [n.role] : [],
          announcement,
          value: '',
          state: {
            enabled: n.enabled,
            selected: !!n.selected,
            focused: n.focused,
            checked: n.checked,
          },
        });
      }

      const enriched: WebA11yNode = {
        ...n,
        nodeId: path,
        accessibilityOrder,
        accessibleName: n.name,
        ariaLabel: n.name, // Playwright's `name` is the computed accessible name; alias it.
        ariaDescription: '',
        focusable,
        announcement,
        children: kids,
      };
      return enriched;
    });
  }

  return { hierarchy: walk(hierarchy.elements, ''), a11ySnapshot: snapshot };
}
