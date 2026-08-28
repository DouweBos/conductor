import { parseDocument, isMap, type Document } from "yaml";

/**
 * A flow's Maestro custom properties — the `properties:` map in its header.
 * Maestro carries them into JUnit and HTML reports, so `testCaseId` is how a
 * flow says which test case it covers in a way that survives without Studio:
 * CI's report names the case, and the repo alone answers what is automated.
 *
 * Electron-free by design so it stays testable as plain Node.
 */

const SEPARATOR = /^---[ \t]*$/m;
const TEST_CASE_ID = "testCaseId";
const PRIORITY = "priority";

/**
 * Header and body of a flow, split on the `---` that ends the header. A flow
 * without one is all body — commands, no header to read properties from.
 */
function split(content: string): { header: string; body: string } {
  const match = SEPARATOR.exec(content);
  if (!match) return { header: "", body: `\n${content}` };
  const end = match.index + match[0].length;
  return { header: content.slice(0, match.index), body: content.slice(end) };
}

export function propertiesOf(content: string): Record<string, string> {
  const header = parseDocument(split(content).header).toJS() as Record<string, unknown> | null;
  const properties = header?.properties;
  if (!properties || typeof properties !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
    if (value !== null && typeof value !== "object") out[key] = String(value);
  }
  return out;
}

/**
 * The cases a flow covers. One flow usually covers one case, but a comma-
 * separated list is allowed: Maestro property values are plain strings, and a
 * flow that verifies two cases shouldn't have to be split in half.
 */
export function testCaseIdsOf(content: string): string[] {
  return parseIds(propertiesOf(content)[TEST_CASE_ID]);
}

export function parseIds(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((ref) => ref.trim())
    .filter(Boolean);
}

/**
 * Set (or clear) a flow's `testCaseId`, and the case's `priority` alongside it,
 * leaving everything else — comments, key order, the body — exactly as it was.
 *
 * Unlinking clears only `testCaseId`: a priority someone set by hand is theirs,
 * not ours to delete.
 */
export function withTestCaseIds(content: string, refs: string[], priority?: string): string {
  const { header, body } = split(content);
  const doc = parseDocument(header);
  const value = [...new Set(refs.map((r) => r.trim()).filter(Boolean))].join(", ");

  if (!isMap(doc.contents)) {
    // A flow with no header at all: give it one rather than refusing the link.
    if (!value) return content;
    const lines = [`  ${TEST_CASE_ID}: "${value}"`];
    if (priority) lines.push(`  ${PRIORITY}: "${priority}"`);
    return `properties:\n${lines.join("\n")}\n---${body}`;
  }

  const properties = doc.get("properties");
  if (!value) {
    if (isMap(properties)) {
      properties.delete(TEST_CASE_ID);
      if (properties.items.length === 0) doc.delete("properties");
    }
    return join(doc, body);
  }

  if (isMap(properties)) {
    properties.set(TEST_CASE_ID, value);
    if (priority) properties.set(PRIORITY, priority);
  } else {
    doc.set("properties", {
      [TEST_CASE_ID]: value,
      ...(priority ? { [PRIORITY]: priority } : {}),
    });
  }
  return join(doc, body);
}

function join(doc: Document, body: string): string {
  const header = doc.toString({ lineWidth: 0 }).replace(/\n+$/, "");
  return `${header}\n---${body}`;
}
