import { autocompletion, type CompletionSource } from "@codemirror/autocomplete";
import { javascript } from "@codemirror/lang-javascript";
import { yaml } from "@codemirror/lang-yaml";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";

import styles from "./Editor.module.css";

export type EditorLanguage = "yaml" | "javascript";

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
  /** Receives an imperative API once mounted, and `null` on unmount. */
  registerApi?: (api: EditorApi | null) => void;
  className?: string;
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
  registerApi,
  className,
}: EditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartment = useRef(new Compartment());
  const themeCompartment = useRef(new Compartment());
  const completionCompartment = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
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
        EditorView.editable.of(!readOnly),
        EditorState.readOnly.of(readOnly),
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
