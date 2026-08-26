/**
 * Minimal XML parser shared by the driver hierarchy adapters (Vega toolkit output,
 * Roku ECP `app-ui`). Handles elements, attributes, text nodes, self-closing tags,
 * and skips declarations/comments — sufficient for well-formed device output, and
 * cheaper than pulling in a dependency for two callers.
 */

export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

/** Parse a document and return its root element, or null if there is none. */
export function parseXml(xml: string): XmlNode | null {
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

/** First direct child element with the given tag name. */
export function childElement(parent: XmlNode, tag: string): XmlNode | undefined {
  return parent.children.find((c) => c.tag === tag);
}

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
