import { autocompletion, type CompletionSource } from "@codemirror/autocomplete";
import { javascript } from "@codemirror/lang-javascript";
import { linter, type Diagnostic } from "@codemirror/lint";
import { yaml } from "@codemirror/lang-yaml";
import { Compartment, EditorState, RangeSet, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, gutter, keymap, type DecorationSet } from "@codemirror/view";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";

import { iconElement } from "../../icons/Icons";
import styles from "./Editor.module.css";

export type EditorLanguage = "yaml" | "javascript";

/**
 * Run controls in the gutter: a play button on each listed line, plus a chevron
 * that asks the host to open a menu at that point.
 */
/** A problem to underline, addressed by 1-based line. */
export interface EditorProblem {
  line: number;
  severity: "error" | "warning" | "info";
  message: string;
}

export interface EditorRunGutter {
  /** 1-based lines that get a control. */
  lines: number[];
  onRun: (line: number) => void;
  onMenu: (line: number, x: number, y: number) => void;
  /**
   * Lines a control would run, so hovering it can show you what you're about to
   * run. `kind` is "run" for the play button and "until" for the menu.
   */
  rangeFor?: (line: number, kind: "run" | "until") => { from: number; to: number };
  runLabel?: string;
  menuLabel?: string;
}

/** Imperative handle for reading editor state (e.g. "run selection"). */
export interface EditorApi {
  getValue: () => string;
  getSelection: () => string;
}

export interface EditorProps {
  value: string;
  onChange?: (value: string) => void;
  language?: EditorLanguage;
  theme?: "light" | "dark";
  readOnly?: boolean;
  /** Fires on Cmd/Ctrl+S. */
  onSave?: () => void;
  /** Extra completions offered alongside the language's own. */
  completions?: CompletionSource;
  /** Per-line run controls shown in the gutter on hover. */
  runGutter?: EditorRunGutter;
  /** Cmd/Ctrl-click on a line: the host decides whether it names something. */
  onFollowLine?: (lineText: string) => void;
  /** Problems to underline in the text. */
  problems?: EditorProblem[];
  /** Receives an imperative API once mounted, and `null` on unmount. */
  registerApi?: (api: EditorApi | null) => void;
  className?: string;
}

/** Lines a gutter control is about to run, shown while it's hovered. */
const setRunHighlight = StateEffect.define<{ from: number; to: number } | null>();
const runHighlightLine = Decoration.line({ class: styles.runHighlight });

const runHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setRunHighlight)) continue;
      if (!effect.value) return Decoration.none;
      const marks = [];
      for (let line = effect.value.from; line <= Math.min(effect.value.to, tr.state.doc.lines); line++) {
        marks.push(runHighlightLine.range(tr.state.doc.line(line).from));
      }
      next = Decoration.set(marks);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

class RunMarker extends GutterMarker {
  constructor(
    private readonly line: number,
    private readonly config: EditorRunGutter,
  ) {
    super();
  }

  eq(other: RunMarker) {
    return other.line === this.line && other.config === this.config;
  }

  toDOM(view: EditorView) {
    const highlight = (kind: "run" | "until" | null) => {
      const range = kind && this.config.rangeFor ? this.config.rangeFor(this.line, kind) : null;
      view.dispatch({ effects: setRunHighlight.of(range) });
    };

    const wrap = document.createElement("div");
    wrap.className = styles.runControls;

    const play = document.createElement("button");
    play.type = "button";
    play.className = styles.runButton;
    play.title = this.config.runLabel ?? "Run this step";
    play.setAttribute("aria-label", play.title);
    play.append(iconElement("play", 12));
    play.onmousedown = (event) => event.preventDefault();
    play.onmouseenter = () => highlight("run");
    play.onmouseleave = () => highlight(null);
    play.onclick = () => this.config.onRun(this.line);

    const menu = document.createElement("button");
    menu.type = "button";
    menu.className = styles.runMenuButton;
    menu.title = this.config.menuLabel ?? "More run options";
    menu.setAttribute("aria-label", menu.title);
    menu.append(iconElement("chevronDown", 12));
    menu.onmousedown = (event) => event.preventDefault();
    menu.onmouseenter = () => highlight("until");
    menu.onmouseleave = () => highlight(null);
    menu.onclick = (event) => {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      this.config.onMenu(this.line, rect.left, rect.bottom);
    };

    wrap.append(play, menu);
    return wrap;
  }
}

function runGutterExtension(config?: EditorRunGutter) {
  if (!config) return [];
  return [
    runHighlightField,
    gutter({
      class: styles.runGutter,
      markers: (view) => {
        const marks = config.lines
          .filter((line) => line >= 1 && line <= view.state.doc.lines)
          .map((line) => new RunMarker(line, config).range(view.state.doc.line(line).from));
        return RangeSet.of(marks, true);
      },
    }),
  ];
}

function lintExtension(problems?: EditorProblem[]) {
  if (!problems) return [];
  return linter((view: EditorView) => {
    const diagnostics: Diagnostic[] = [];
    for (const problem of problems) {
      if (problem.line < 1 || problem.line > view.state.doc.lines) continue;
      const line = view.state.doc.line(problem.line);
      diagnostics.push({
        from: line.from + (line.text.length - line.text.trimStart().length),
        to: line.to,
        severity: problem.severity,
        message: problem.message,
      });
    }
    return diagnostics;
  });
}

function completionExtension(source?: CompletionSource) {
  return source ? autocompletion({ override: [source] }) : [];
}

function langExtension(language: EditorLanguage) {
  return language === "javascript" ? javascript() : yaml();
}

export function Editor({
  value,
  onChange,
  language = "yaml",
  theme = "light",
  readOnly = false,
  onSave,
  completions,
  runGutter,
  onFollowLine,
  problems,
  registerApi,
  className,
}: EditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartment = useRef(new Compartment());
  const themeCompartment = useRef(new Compartment());
  const completionCompartment = useRef(new Compartment());
  const gutterCompartment = useRef(new Compartment());
  const lintCompartment = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onFollowRef = useRef(onFollowLine);
  onFollowRef.current = onFollowLine;
  const registerApiRef = useRef(registerApi);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  registerApiRef.current = registerApi;

  // Create the view once.
  useEffect(() => {
    if (!hostRef.current) return;
    const saveKeymap = keymap.of([
      {
        key: "Mod-s",
        run: () => {
          onSaveRef.current?.();
          return true;
        },
      },
    ]);
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        saveKeymap,
        langCompartment.current.of(langExtension(language)),
        themeCompartment.current.of(theme === "dark" ? githubDark : githubLight),
        completionCompartment.current.of(completionExtension(completions)),
        gutterCompartment.current.of(runGutterExtension(runGutter)),
        lintCompartment.current.of(lintExtension(problems)),
        EditorView.editable.of(!readOnly),
        EditorState.readOnly.of(readOnly),
        EditorView.domEventHandlers({
          mousedown(event, view) {
            if (!(event.metaKey || event.ctrlKey) || !onFollowRef.current) return false;
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos === null) return false;
            onFollowRef.current(view.state.doc.lineAt(pos).text);
            return false;
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current?.(update.state.doc.toString());
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    registerApiRef.current?.({
      getValue: () => view.state.doc.toString(),
      getSelection: () => {
        const { from, to } = view.state.selection.main;
        return view.state.sliceDoc(from, to);
      },
    });
    return () => {
      registerApiRef.current?.(null);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external value changes (e.g. switching files).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  // Reconfigure completions.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: completionCompartment.current.reconfigure(completionExtension(completions)),
    });
  }, [completions]);

  // Reconfigure the run gutter — its lines move on every edit.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: gutterCompartment.current.reconfigure(runGutterExtension(runGutter)),
    });
  }, [runGutter]);

  // Reconfigure diagnostics.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: lintCompartment.current.reconfigure(lintExtension(problems)),
    });
  }, [problems]);

  // Reconfigure language.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: langCompartment.current.reconfigure(langExtension(language)),
    });
  }, [language]);

  // Reconfigure theme.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartment.current.reconfigure(
        theme === "dark" ? githubDark : githubLight,
      ),
    });
  }, [theme]);

  return <div ref={hostRef} className={[styles.editor, className].filter(Boolean).join(" ")} />;
}
