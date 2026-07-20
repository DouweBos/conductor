/**
 * Converts the Vega automation toolkit's `getPageSource` XML into the
 * uiautomator-style `<node>` XML that conductor's Android element resolver
 * (`parseAndroidHierarchy`, `findAndroidElement`, `inspectAndroidToText`)
 * already understands. This lets Vega reuse the entire Android inspection and
 * element-resolution path unchanged.
 *
 * Toolkit shape: `<root><app appName><window x/y/width/height><child role test_id
 * focusable selectable clickable focused selected>…<text>label</text></child>
 * </window></app></root>`. `<traits>` subtrees are metadata (dropped); bare
 * structural wrappers (no role, interactivity, or text) are flattened; the
 * persistent Kepler launcher app is filtered so only the foreground app shows.
 * Coordinates are absolute device pixels — emitted as `[x,y][x+w,y+h]`, exactly
 * like the Android adapter (no normalization).
 */

const LAUNCHER_APP = 'com.amazon.keplerlauncherapp';

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

/** Parse Vega toolkit XML and re-emit it as uiautomator `<node>` XML. */
export function parseVegaPageSource(xml: string): string {
  const root = parseXml(xml);
  if (!root) return '<?xml version="1.0" encoding="UTF-8"?>\n<hierarchy />';

  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<hierarchy>'];
  for (const scope of foregroundScopes(root)) {
    for (const child of scope.children) {
      emitNode(child, lines, 1);
    }
  }
  lines.push('</hierarchy>');
  return lines.join('\n');
}

/** The `<app>` subtrees to render: foreground apps, excluding the launcher. */
function foregroundScopes(root: XmlNode): XmlNode[] {
  const apps = root.children.filter((c) => c.tag === 'app');
  if (apps.length === 0) return [root];
  const foreground = apps.filter((a) => a.attrs['appName'] !== LAUNCHER_APP);
  return foreground.length > 0 ? foreground : apps;
}

function emitNode(node: XmlNode, lines: string[], depth: number): void {
  if (node.tag === 'traits' || node.tag === 'text') return;

  const meaningful = isMeaningful(node);
  const rendered = node.children.filter((c) => c.tag !== 'traits' && c.tag !== 'text');

  if (!meaningful) {
    // Flatten structural wrapper — emit its children in its place.
    for (const child of rendered) emitNode(child, lines, depth);
    return;
  }

  const attrs: string[] = [];
  const role = node.attrs['role'];
  if (role) attrs.push(`class="${xmlEscape(role)}"`);
  const testId = node.attrs['test_id'];
  if (testId) attrs.push(`resource-id="${xmlEscape(testId)}"`);
  const label = labelOf(node);
  if (label) attrs.push(`text="${xmlEscape(label)}"`);
  attrs.push(`bounds="${boundsOf(node)}"`);
  const interactive = isInteractive(node);
  attrs.push(`clickable="${interactive ? 'true' : 'false'}"`);
  if (node.attrs['focused'] !== undefined) {
    attrs.push(`focused="${boolAttr(node, 'focused')}"`);
  }
  if (node.attrs['selected'] !== undefined) {
    attrs.push(`selected="${boolAttr(node, 'selected')}"`);
  }
  attrs.push('enabled="true"');

  const indent = '  '.repeat(depth);
  if (rendered.length === 0) {
    lines.push(`${indent}<node ${attrs.join(' ')} />`);
    return;
  }
  lines.push(`${indent}<node ${attrs.join(' ')}>`);
  for (const child of rendered) emitNode(child, lines, depth + 1);
  lines.push(`${indent}</node>`);
}

// A node earns a line when it carries meaning: an explicit role, interactivity,
// or its own text. Bare structural wrappers are flattened.
function isMeaningful(node: XmlNode): boolean {
  return !!node.attrs['role'] || isInteractive(node) || labelOf(node).length > 0;
}

function isInteractive(node: XmlNode): boolean {
  return boolAttr(node, 'focusable') || boolAttr(node, 'selectable') || boolAttr(node, 'clickable');
}

/** Label = this node's direct text plus the text of its direct `<text>` children. */
function labelOf(node: XmlNode): string {
  const parts: string[] = [];
  if (node.text.trim()) parts.push(node.text.trim());
  for (const child of node.children) {
    if (child.tag === 'text' && child.text.trim()) parts.push(child.text.trim());
  }
  return parts.join(' ').trim();
}

function boundsOf(node: XmlNode): string {
  const x = intAttr(node, 'x');
  const y = intAttr(node, 'y');
  const w = intAttr(node, 'width');
  const h = intAttr(node, 'height');
  return `[${x},${y}][${x + w},${y + h}]`;
}

function boolAttr(node: XmlNode, name: string): boolean {
  const v = (node.attrs[name] ?? '').trim().toLowerCase();
  return v === 'true' || v === '1';
}

function intAttr(node: XmlNode, name: string): number {
  return parseInt(node.attrs[name] ?? '', 10) || 0;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Minimal XML parser ────────────────────────────────────────────────────────
// Handles elements, attributes, text nodes, self-closing tags, and skips the XML
// declaration / comments. Sufficient for the well-formed toolkit output.

function parseXml(xml: string): XmlNode | null {
  let i = 0;
  const n = xml.length;

  function skipWhitespace(): void {
    while (i < n && /\s/.test(xml[i])) i++;
  }

  function parseNode(): XmlNode | null {
    // Skip declarations, comments, and processing instructions before the tag.
    while (i < n) {
      skipWhitespace();
      if (xml.startsWith('<?', i)) {
        i = xml.indexOf('?>', i);
        i = i === -1 ? n : i + 2;
        continue;
      }
      if (xml.startsWith('<!--', i)) {
        i = xml.indexOf('-->', i);
        i = i === -1 ? n : i + 3;
        continue;
      }
      if (xml.startsWith('<!', i)) {
        i = xml.indexOf('>', i);
        i = i === -1 ? n : i + 1;
        continue;
      }
      break;
    }
    if (i >= n || xml[i] !== '<') return null;
    i++; // consume '<'

    // Read tag name
    const nameStart = i;
    while (i < n && !/[\s/>]/.test(xml[i])) i++;
    const tag = xml.slice(nameStart, i);

    const attrs: Record<string, string> = {};
    // Read attributes
    while (i < n) {
      skipWhitespace();
      if (xml[i] === '/' || xml[i] === '>') break;
      const attrNameStart = i;
      while (i < n && !/[\s=/>]/.test(xml[i])) i++;
      const attrName = xml.slice(attrNameStart, i);
      skipWhitespace();
      let attrValue = '';
      if (xml[i] === '=') {
        i++; // consume '='
        skipWhitespace();
        const quote = xml[i];
        if (quote === '"' || quote === "'") {
          i++;
          const valStart = i;
          while (i < n && xml[i] !== quote) i++;
          attrValue = xmlUnescape(xml.slice(valStart, i));
          i++; // consume closing quote
        }
      }
      if (attrName) attrs[attrName] = attrValue;
    }

    const node: XmlNode = { tag, attrs, children: [], text: '' };

    if (xml[i] === '/') {
      // self-closing
      i = xml.indexOf('>', i);
      i = i === -1 ? n : i + 1;
      return node;
    }
    i++; // consume '>'

    // Read children / text until closing tag
    while (i < n) {
      if (xml.startsWith('</', i)) {
        i = xml.indexOf('>', i);
        i = i === -1 ? n : i + 1;
        break;
      }
      if (xml[i] === '<') {
        const child = parseNode();
        if (child) node.children.push(child);
      } else {
        const textStart = i;
        while (i < n && xml[i] !== '<') i++;
        node.text += xmlUnescape(xml.slice(textStart, i));
      }
    }
    return node;
  }

  return parseNode();
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
