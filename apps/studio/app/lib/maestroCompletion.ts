import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";

import { COMMANDS, COMMANDS_BY_NAME, HEADER_KEYS, paramsFor } from "./maestroSchema";

/**
 * Autocomplete for Maestro flow YAML: commands where a step goes, that command's
 * parameters inside its block, and env variables inside `${…}`. Everything is
 * driven off indentation, which is all the structure a half-typed flow has.
 */

const indentOf = (line: string) => line.length - line.trimStart().length;

/** Command owning the block the cursor sits in, by walking up to a shallower list item. */
function enclosingCommand(lines: string[], row: number, indent: number): string | null {
  for (let i = row - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    const at = indentOf(line);
    if (at >= indent) continue;
    const match = /^-\s+([A-Za-z]\w*):/.exec(line.trim());
    return match ? match[1] : null;
  }
  return null;
}

/** Names declared in the document: `env:` keys and every `${VAR}` already used. */
function documentEnvNames(doc: string): string[] {
  const names = new Set<string>();
  const lines = doc.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*env:\s*$/.test(lines[i])) continue;
    const blockIndent = indentOf(lines[i]);
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) continue;
      if (indentOf(line) <= blockIndent) break;
      const key = /^([A-Za-z_]\w*)\s*:/.exec(line.trim());
      if (key) names.add(key[1]);
    }
  }
  for (const match of doc.matchAll(/\$\{\s*([A-Za-z_]\w*)/g)) names.add(match[1]);
  return [...names];
}

const commandOptions: Completion[] = COMMANDS.map((c) => ({
  label: c.name,
  type: "keyword",
  detail: c.doc,
  // Selector commands read best inline; the rest open a block.
  apply: c.selector ? `${c.name}: ` : `${c.name}:\n    `,
}));

const headerOptions: Completion[] = HEADER_KEYS.map((k) => ({
  label: k.name,
  type: "property",
  detail: k.detail,
  apply: `${k.name}: `,
}));

/**
 * @param extraEnvNames names the project defines outside this file — config.yaml
 * and the `env:` blocks of the subflows it can call.
 */
export function maestroCompletion(extraEnvNames: () => string[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const doc = context.state.doc.toString();
    const line = context.state.doc.lineAt(context.pos);
    const before = context.state.sliceDoc(line.from, context.pos);

    // ${ENV_VAR} — anywhere, including inside a quoted string.
    const envMatch = /\$\{\s*([A-Za-z_]\w*)?$/.exec(before);
    if (envMatch) {
      // Scan the document with the half-typed `${…` removed, so the fragment
      // under the cursor doesn't come back as a suggestion.
      const start = context.pos - envMatch[0].length;
      const scanned = doc.slice(0, start) + doc.slice(context.pos);
      const names = new Set([...documentEnvNames(scanned), ...extraEnvNames()]);
      if (names.size === 0) return null;
      return {
        from: context.pos - (envMatch[1]?.length ?? 0),
        options: [...names].sort().map((name) => ({
          label: name,
          type: "variable",
          detail: "env",
        })),
        validFor: /^\w*$/,
      };
    }

    const word = /([A-Za-z]\w*)?$/.exec(before);
    const from = context.pos - (word?.[1]?.length ?? 0);
    const typed = word?.[1] ?? "";
    // Only complete at the end of a key — never inside a value.
    if (/:\s.*$/.test(before.slice(0, before.length - typed.length))) return null;

    const trimmed = before.trimStart();
    const lines = doc.split(/\r?\n/);
    const row = line.number - 1;

    // A new step: "- " or "- ta|".
    if (/^-\s*[A-Za-z]*$/.test(trimmed)) {
      return { from, options: commandOptions, validFor: /^\w*$/ };
    }

    if (!context.explicit && !typed) return null;

    // A bare key inside a command's block → that command's parameters.
    if (/^[A-Za-z]*$/.test(trimmed)) {
      const command = enclosingCommand(lines, row, indentOf(before));
      const def = command ? COMMANDS_BY_NAME.get(command) : null;
      if (def) {
        return {
          from,
          options: paramsFor(def).map((p) => ({
            label: p.name,
            type: "property",
            detail: p.detail,
            apply: `${p.name}: `,
          })),
          validFor: /^\w*$/,
        };
      }
      // Above the `---`, the header keys are what's on offer.
      const separator = doc.indexOf("\n---");
      if (separator === -1 || context.pos <= separator) {
        return { from, options: headerOptions, validFor: /^\w*$/ };
      }
    }
    return null;
  };
}
