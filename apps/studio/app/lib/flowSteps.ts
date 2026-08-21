/**
 * Where each step of a flow starts and ends. Steps are the top-level list items
 * below the `---`, so a step owns every following line indented under it. Used
 * to run one step, or everything up to one, without running the whole flow.
 */

export interface StepRange {
  /** 1-based line of the `- command:` that opens the step. */
  line: number;
  /** 1-based line the step ends on, inclusive. */
  endLine: number;
}

/** Index (0-based) of the `---` that separates the header from the steps. */
function separatorRow(lines: string[]): number {
  return lines.findIndex((line) => /^---\s*$/.test(line));
}

export function parseSteps(doc: string): StepRange[] {
  const lines = doc.split(/\r?\n/);
  const start = separatorRow(lines) + 1;
  const steps: StepRange[] = [];
  for (let i = start; i < lines.length; i++) {
    if (!/^-\s+\S/.test(lines[i])) continue;
    steps.push({ line: i + 1, endLine: lines.length });
    if (steps.length > 1) steps[steps.length - 2].endLine = i;
  }
  // Trim trailing blank lines off the last step.
  const last = steps[steps.length - 1];
  if (last) {
    while (last.endLine > last.line && !lines[last.endLine - 1].trim()) last.endLine -= 1;
  }
  return steps;
}

/** The flow's header — everything above the `---`, which carries appId and env. */
export function headerOf(doc: string): string {
  const lines = doc.split(/\r?\n/);
  const separator = separatorRow(lines);
  return separator < 0 ? "" : lines.slice(0, separator).join("\n");
}

/**
 * A runnable flow containing only the given steps, keeping the original header
 * so `appId` and the flow's `env` defaults still apply.
 */
export function flowForSteps(doc: string, steps: StepRange[]): string {
  const lines = doc.split(/\r?\n/);
  const body = steps
    .map((step) => lines.slice(step.line - 1, step.endLine).join("\n"))
    .join("\n");
  const header = headerOf(doc);
  return `${header}\n---\n${body}\n`;
}

/** The step opening on this line, and every step before it. */
export function stepsUntil(steps: StepRange[], line: number): StepRange[] {
  const index = steps.findIndex((s) => s.line === line);
  return index < 0 ? [] : steps.slice(0, index + 1);
}

/**
 * Every step the line range touches, whole. Selecting down to `- assertVisible:`
 * without its indented `id:` would otherwise run a command with no value, which
 * the engine rejects outright.
 */
export function stepsInRange(steps: StepRange[], from: number, to: number): StepRange[] {
  return steps.filter((s) => s.line <= to && s.endLine >= from);
}

export function stepAt(steps: StepRange[], line: number): StepRange | null {
  return steps.find((s) => s.line === line) ?? null;
}
