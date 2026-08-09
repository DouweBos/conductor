import { stringify } from "yaml";

import type { CaptureElement, CaptureUiResult, Platform } from "./types";

/**
 * Maestro commands suggested for an element you picked off the device, modelled
 * on Maestro Studio's command examples: one entry per (command × selector), best
 * selector first. Selectors prefer the accessibility id, then text, then a
 * percentage coordinate that survives a resolution change.
 */

export interface CommandSuggestion {
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
  const add = (command: string, selectors: Selector[], build: (s: Selector) => string) => {
    for (const s of selectors) suggestions.push({ title: `${command} · ${s.title}`, content: build(s) });
  };

  if (tv) {
    // tvOS is focus-driven: there's nothing to tap, you move the remote.
    for (const key of REMOTE_KEYS) {
      suggestions.push({ title: `Press · ${key}`, content: step({ pressKey: key }) });
    }
  } else {
    add("Tap", tappable, (s) => step({ tapOn: s.definition }));
    add("Long press", tappable, (s) => step({ longPressOn: s.definition }));
    add("Input text", tappable, (s) =>
      [step({ tapOn: s.definition }), step({ inputText: "TODO" })].join("\n"),
    );
  }
  add("Assert", matchers, (s) => step({ assertVisible: s.definition }));
  add("Copy text", matchers, (s) => step({ copyTextFrom: s.definition }));
  add("Conditional", matchers, (s) =>
    step({ runFlow: { when: { visible: s.definition }, file: "Subflow.yaml" } }),
  );
  return suggestions;
}

/** One-line description of an element, for hover hints and list rows. */
export function describeElement(element: CaptureElement): string {
  if (element.identifier) return element.identifier;
  if (element.text) return element.text;
  return element.role || element.ref;
}
