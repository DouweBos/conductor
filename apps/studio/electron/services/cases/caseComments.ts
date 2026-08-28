/**
 * Case prose, commented for a scaffolded flow. Electron-free so it stays
 * testable as plain Node.
 */

/**
 * `# <label><text>`, with every further line of `text` commented too and
 * aligned under it — a step's expected result is regularly several lines, and
 * an uncommented one breaks the YAML.
 */
export function commented(label: string, text: string): string[] {
  const [first = "", ...rest] = text.split("\n");
  const indent = " ".repeat(label.length);
  return [
    `# ${label}${first.trim()}`,
    ...rest.map((line) => (line.trim() ? `# ${indent}${line.trim()}` : "#")),
  ];
}
