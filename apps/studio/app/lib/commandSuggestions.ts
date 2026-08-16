import { stringify } from "yaml";

import type { CaptureElement, CaptureUiResult, Platform } from "./types";

/**
 * Maestro commands suggested for an element you picked off the device, modelled
 * on Maestro Studio's command examples: one entry per (command × selector), best
 * selector first. Selectors prefer the accessibility id, then text, then a
 * percentage coordinate that survives a resolution change.
 */

/** How suggestions are tabbed, so a long list stays navigable. */
export type CommandGroup = "Press" | "Tap" | "Assert" | "Scroll" | "Other";

export interface CommandSuggestion {
  group: CommandGroup;
  /** e.g. "Tap · Id" */
  title: string;
  /** The YAML step, ready to paste into a flow. */
  content: string;
}

interface Selector {
  title: string;
  definition: unknown;
}

const YAML_OPTIONS = {
  lineWidth: 0,
  defaultKeyType: "PLAIN",
  defaultStringType: "QUOTE_DOUBLE",
} as const;

function step(value: unknown): string {
  return stringify([value], YAML_OPTIONS).trimEnd();
}

const percent = (n: number, total: number) => `${Math.round((100 * n) / total)}%`;

function selectorsFor(element: CaptureElement, screen: CaptureUiResult): Selector[] {
  const selectors: Selector[] = [];
  if (element.identifier) {
    selectors.push({ title: "Id", definition: { id: element.identifier } });
  }
  if (element.text) {
    // A text that isn't unique on screen needs an index to resolve to this one.
    const matches = collect(screen.root).filter((e) => e.text === element.text);
    const index = matches.length > 1 ? matches.indexOf(element) : -1;
    selectors.push({
      title: "Text",
      definition: index >= 0 ? { text: element.text, index } : element.text,
    });
  }
  return selectors;
}

/** A selector plus state flags. Bare-string selectors become `text:` to fit one. */
function withState(definition: unknown, state: Record<string, boolean>): unknown {
  const base = typeof definition === "string" ? { text: definition } : definition;
  return { ...(base as object), ...state };
}

/** Only tap-like commands can address a raw point; asserts need a matcher. */
function coordinateSelector(element: CaptureElement, screen: CaptureUiResult): Selector | null {
  if (!element.bounds || !screen.width || !screen.height) return null;
  const { x, y, width, height } = element.bounds;
  return {
    title: "Coordinates",
    definition: {
      point: `${percent(x + width / 2, screen.width)},${percent(y + height / 2, screen.height)}`,
    },
  };
}

/** Every element in the tree, in document order. */
function collect(root: CaptureElement, into: CaptureElement[] = []): CaptureElement[] {
  for (const child of root.children ?? []) {
    into.push(child);
    collect(child, into);
  }
  return into;
}

/** tvOS is focus-driven — tapping a point isn't a thing, so offer the remote. */
const REMOTE_KEYS = [
  "Remote Dpad Center",
  "Remote Dpad Up",
  "Remote Dpad Down",
  "Remote Dpad Left",
  "Remote Dpad Right",
  "Remote Menu",
];

const SCROLL_DIRECTIONS = ["DOWN", "UP", "LEFT", "RIGHT"];

const GROUP_ORDER: CommandGroup[] = ["Press", "Tap", "Assert", "Scroll", "Other"];

export function commandSuggestions(
  element: CaptureElement,
  screen: CaptureUiResult,
  platform: Platform = "ios",
): CommandSuggestion[] {
  const matchers = selectorsFor(element, screen);
  const coordinates = coordinateSelector(element, screen);
  const tappable = coordinates ? [...matchers, coordinates] : matchers;
  const tv = platform === "tvos";

  const suggestions: CommandSuggestion[] = [];
  const add = (
    group: CommandGroup,
    command: string,
    selectors: Selector[],
    build: (s: Selector) => string,
  ) => {
    for (const s of selectors) {
      suggestions.push({ group, title: `${command} · ${s.title}`, content: build(s) });
    }
  };

  if (tv) {
    // tvOS is focus-driven: there's nothing to tap, you move the remote.
    for (const key of REMOTE_KEYS) {
      suggestions.push({ group: "Press", title: `Press · ${key}`, content: step({ pressKey: key }) });
    }
  } else {
    add("Tap", "Tap", tappable, (s) => step({ tapOn: s.definition }));
    add("Tap", "Long press", tappable, (s) => step({ longPressOn: s.definition }));
    add("Tap", "Input text", tappable, (s) =>
      [step({ tapOn: s.definition }), step({ inputText: "TODO" })].join("\n"),
    );
  }
  add("Assert", "Assert visible", matchers, (s) => step({ assertVisible: s.definition }));
  add("Assert", "Assert not visible", matchers, (s) => step({ assertNotVisible: s.definition }));
  // On a focus-driven UI "is it visible" is the weaker half of the check — the
  // point of a D-pad flow is that focus landed where you meant it to.
  if (element.focused) {
    add("Assert", "Assert focused", matchers, (s) =>
      step({ assertVisible: withState(s.definition, { focused: true }) }),
    );
  } else if (tv) {
    // Only worth offering on a TV, where exactly one element holds focus and
    // "not this one" is a real check. On touch almost nothing is focused, so
    // the same assertion would pass without testing anything.
    add("Assert", "Assert not focused", matchers, (s) =>
      step({ assertVisible: withState(s.definition, { focused: false }) }),
    );
  }
  // Scrolling is a swipe, so it's touch-only — a TV scrolls by moving focus.
  if (!tv) {
    for (const direction of SCROLL_DIRECTIONS) {
      add("Scroll", `Scroll ${direction.toLowerCase()} until visible`, matchers.slice(0, 1), (s) =>
        step({ scrollUntilVisible: { element: s.definition, direction } }),
      );
    }
  }
  add("Other", "Copy text", matchers, (s) => step({ copyTextFrom: s.definition }));
  add("Other", "Conditional", matchers, (s) =>
    step({ runFlow: { when: { visible: s.definition }, file: "Subflow.yaml" } }),
  );
  return suggestions;
}

/** Suggestions bucketed into their tabs, empty groups dropped, in a fixed order. */
export function groupSuggestions(
  suggestions: CommandSuggestion[],
): { group: CommandGroup; items: CommandSuggestion[] }[] {
  return GROUP_ORDER.map((group) => ({
    group,
    items: suggestions.filter((s) => s.group === group),
  })).filter((g) => g.items.length > 0);
}

/**
 * The `assertVisible` step for an element, with state flags folded in. Goes
 * through the same YAML writer as the suggestions, so a label carrying a colon
 * or a quote comes out escaped rather than producing a broken step.
 */
export function assertVisibleStep(
  element: CaptureElement,
  state: Record<string, boolean> = {},
): string | null {
  const selector = element.identifier
    ? { id: element.identifier }
    : element.text
      ? { text: element.text }
      : null;
  return selector ? step({ assertVisible: { ...selector, ...state } }) : null;
}

/** One-line description of an element, for hover hints and list rows. */
export function describeElement(element: CaptureElement): string {
  if (element.identifier) return element.identifier;
  if (element.text) return element.text;
  return element.role || element.ref;
}
