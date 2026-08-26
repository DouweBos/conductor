/**
 * Converts Roku's ECP `/query/app-ui` SceneGraph XML into the uiautomator-style
 * `<node>` XML that conductor's Android element resolver (`parseAndroidHierarchy`,
 * `findAndroidElement`, `inspectAndroidToText`) already understands — the same
 * trick Vega uses, so Roku reuses the entire inspection and element-resolution path.
 *
 * app-ui shape:
 * ```
 * <app-ui>
 *   <status>OK</status>
 *   <topscreen>
 *     <plugin id="dev" name="MyApp"/>
 *     <screen focused="true" type="screen">
 *       <RenderableNode name="myId" subtype="Group" bounds="{0, 0, 1920, 1080}" …>
 * ```
 * Node `name` attributes (SceneGraph node ids) become `resource-id`, `subtype`
 * becomes `class`, and `bounds` are accumulated with parent `translation` offsets
 * into scene-absolute `[x1,y1][x2,y2]` rects — the Android adapter's format.
 */
import { XmlNode, parseXml, childElement, xmlEscape } from '../xml.js';

interface Offset {
  x: number;
  y: number;
}

const EMPTY = '<?xml version="1.0" encoding="UTF-8"?>\n<hierarchy />';

/** Parse Roku app-ui XML and re-emit it as uiautomator `<node>` XML. */
export function parseRokuAppUI(xml: string, screenWidth = 1920, screenHeight = 1080): string {
  const root = parseXml(xml);
  if (!root) return EMPTY;

  const topscreen = childElement(root, 'topscreen');
  const screen = topscreen && childElement(topscreen, 'screen');
  if (!screen) return EMPTY;

  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<hierarchy>'];
  // A root node spanning the screen: it gives the screenshot cropper its reference
  // bounds, matching the window node Android and Vega both emit.
  // Never focused: `<screen focused>` means the screen holds device focus, not that
  // it is the focused element, and claiming it here would shadow the real one.
  const rootAttrs = [
    'class="Screen"',
    `bounds="[0,0][${screenWidth},${screenHeight}]"`,
    'clickable="false"',
    'focusable="false"',
    'focused="false"',
    'enabled="true"',
  ];
  lines.push(`  <node ${rootAttrs.join(' ')}>`);
  emitChildren(screen, { x: 0, y: 0 }, false, lines, 2);
  lines.push('  </node>');
  lines.push('</hierarchy>');
  return lines.join('\n');
}

function emitChildren(
  parent: XmlNode,
  offset: Offset,
  parentIsRowListItem: boolean,
  lines: string[],
  depth: number
): void {
  // A RowListItem's trailing Group duplicates the item it wraps.
  const children =
    parentIsRowListItem && parent.children.length > 1
      ? parent.children.slice(0, -1)
      : parent.children;

  for (const child of children) emitNode(child, offset, parentIsRowListItem, lines, depth);
}

function emitNode(
  node: XmlNode,
  parentOffset: Offset,
  parentIsRowListItem: boolean,
  lines: string[],
  depth: number
): void {
  // SceneGraph doesn't render an invisible node or anything beneath it, but ECP
  // still reports the subtree with real bounds. Keeping them would let
  // assert-visible match a hidden element and assert-not-visible fail on one.
  if (node.attrs['visible'] === 'false') return;
  const opacity = parseFloat(node.attrs['opacity'] ?? '100');
  if (!isNaN(opacity) && opacity <= 0) return;

  // ECP reports the SceneGraph type in `subtype`; the element name is only a
  // fallback, and for a generic `RenderableNode` it says nothing at all.
  const subtype = node.attrs['subtype'] || (node.tag === 'RenderableNode' ? 'Group' : node.tag);

  const translation = parseNumericArray(node.attrs['translation'], 2);
  const bounds = parseNumericArray(node.attrs['bounds'], 4);

  // Offset this node's children inherit.
  let nodeOffset = parentOffset;
  if (subtype === 'MarkupGrid' && parentIsRowListItem) {
    if (bounds) nodeOffset = { x: bounds[0] + parentOffset.x, y: bounds[1] + parentOffset.y };
  } else if (translation) {
    nodeOffset = { x: translation[0] + parentOffset.x, y: translation[1] + parentOffset.y };
  }

  const focusable = node.attrs['focusable'] === 'true';
  const focused = node.attrs['focused'] === 'true';

  const attrs: string[] = [`class="${xmlEscape(subtype)}"`];
  if (node.attrs['name']) attrs.push(`resource-id="${xmlEscape(node.attrs['name'])}"`);
  if (node.attrs['text']) attrs.push(`text="${xmlEscape(node.attrs['text'])}"`);
  if (bounds) {
    const x1 = Math.round(bounds[0] + parentOffset.x);
    const y1 = Math.round(bounds[1] + parentOffset.y);
    attrs.push(
      `bounds="[${x1},${y1}][${x1 + Math.round(bounds[2])},${y1 + Math.round(bounds[3])}]"`
    );
  }
  attrs.push(`clickable="${focusable}"`, `focusable="${focusable}"`);
  attrs.push(`focused="${focused}"`, `selected="${focused}"`, 'enabled="true"');

  const indent = '  '.repeat(depth);
  if (node.children.length === 0) {
    lines.push(`${indent}<node ${attrs.join(' ')} />`);
    return;
  }
  lines.push(`${indent}<node ${attrs.join(' ')}>`);
  emitChildren(node, nodeOffset, node.tag === 'RowListItem', lines, depth + 1);
  lines.push(`${indent}</node>`);
}

/**
 * Parses a Roku numeric array attribute (`{0, 0, 1920, 1080}`), or null if it
 * doesn't hold at least `minSize` values — callers index it positionally, so a
 * short array is no more usable than a missing one.
 */
function parseNumericArray(value: string | undefined, minSize: number): number[] | null {
  if (!value) return null;
  const cleaned = value.replace(/[{}]/g, '').trim();
  if (!cleaned) return null;
  const parsed = cleaned.split(',').map((p) => parseFloat(p.trim()));
  if (parsed.length < minSize || parsed.some((v) => isNaN(v))) return null;
  return parsed;
}
