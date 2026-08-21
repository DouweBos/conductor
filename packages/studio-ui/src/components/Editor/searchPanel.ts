import {
  SearchQuery,
  findNext,
  findPrevious,
  getSearchQuery,
  closeSearchPanel,
  replaceAll,
  replaceNext,
  search,
  setSearchQuery,
} from "@codemirror/search";
import type { EditorState } from "@codemirror/state";
import type { EditorView, Panel } from "@codemirror/view";

import { iconElement } from "../../icons/Icons";
import styles from "./Editor.module.css";

/**
 * Cmd-F, as a compact bar over the editor rather than CodeMirror's default
 * form-in-a-box at the bottom. Replace is behind a toggle, so the common case —
 * find, hit Enter a few times, Escape — is one row.
 *
 * Panels are plain DOM, so this is built imperatively like the run gutter.
 */

/** Counting is per keystroke, so stop once the label would read "99+". */
const MAX_COUNT = 99;

function countMatches(state: EditorState, query: SearchQuery): { total: number; index: number } {
  if (!query.valid) return { total: 0, index: 0 };
  const cursor = query.getCursor(state);
  const head = state.selection.main.from;
  let total = 0;
  let index = 0;
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    total++;
    if (index === 0 && next.value.from >= head) index = total;
    if (total > MAX_COUNT) break;
  }
  // Past the last match the selection wraps to the first one.
  return { total, index: index || (total ? 1 : 0) };
}

function button(icon: Parameters<typeof iconElement>[0], label: string, onClick: () => void) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = styles.searchButton;
  el.title = label;
  el.setAttribute("aria-label", label);
  el.append(iconElement(icon, 14));
  el.onmousedown = (event) => event.preventDefault();
  el.onclick = onClick;
  return el;
}

/** A label-style toggle for the flags that have no sensible glyph. */
function toggle(text: string, label: string, onClick: (on: boolean) => void) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = styles.searchToggle;
  el.title = label;
  el.setAttribute("aria-label", label);
  el.textContent = text;
  el.onmousedown = (event) => event.preventDefault();
  el.onclick = () => {
    const on = el.getAttribute("aria-pressed") !== "true";
    el.setAttribute("aria-pressed", String(on));
    onClick(on);
  };
  el.setAttribute("aria-pressed", "false");
  return el;
}

function createPanel(view: EditorView): Panel {
  const initial = getSearchQuery(view.state);

  const dom = document.createElement("div");
  dom.className = styles.searchPanel;
  dom.onkeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearchPanel(view);
      view.focus();
    }
  };

  const row = document.createElement("div");
  row.className = styles.searchRow;

  const field = document.createElement("div");
  field.className = styles.searchField;
  field.append(iconElement("search", 14));

  const input = document.createElement("input");
  input.className = styles.searchInput;
  input.placeholder = "Find in file";
  input.setAttribute("main-field", "true");
  input.setAttribute("aria-label", "Find");
  input.value = initial.search;
  field.append(input);

  const count = document.createElement("span");
  count.className = styles.searchCount;
  field.append(count);

  const replaceRow = document.createElement("div");
  replaceRow.className = styles.searchRow;
  replaceRow.hidden = true;

  const replaceInput = document.createElement("input");
  replaceInput.className = styles.searchReplace;
  replaceInput.placeholder = "Replace with";
  replaceInput.setAttribute("aria-label", "Replace with");
  replaceInput.value = initial.replace;

  let caseSensitive = initial.caseSensitive;
  let regexp = initial.regexp;
  let wholeWord = initial.wholeWord;

  const commit = () => {
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: input.value,
          replace: replaceInput.value,
          caseSensitive,
          regexp,
          wholeWord,
        }),
      ),
    });
  };

  const caseButton = toggle("Aa", "Match case", (on) => {
    caseSensitive = on;
    commit();
  });
  const wordButton = toggle("ab", "Match whole word", (on) => {
    wholeWord = on;
    commit();
  });
  const regexpButton = toggle(".*", "Use regular expression", (on) => {
    regexp = on;
    commit();
  });
  caseButton.setAttribute("aria-pressed", String(caseSensitive));
  wordButton.setAttribute("aria-pressed", String(wholeWord));
  regexpButton.setAttribute("aria-pressed", String(regexp));

  const replaceToggle = button("chevronDown", "Show replace", () => {
    replaceRow.hidden = !replaceRow.hidden;
    replaceToggle.title = replaceRow.hidden ? "Show replace" : "Hide replace";
    replaceToggle.replaceChildren(iconElement(replaceRow.hidden ? "chevronDown" : "chevronUp", 14));
    if (!replaceRow.hidden) replaceInput.focus();
  });

  input.oninput = commit;
  replaceInput.oninput = commit;
  input.onkeydown = (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    (event.shiftKey ? findPrevious : findNext)(view);
  };
  replaceInput.onkeydown = (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    (event.shiftKey ? replaceAll : replaceNext)(view);
  };

  row.append(
    field,
    button("chevronUp", "Previous match (Shift+Enter)", () => findPrevious(view)),
    button("chevronDown", "Next match (Enter)", () => findNext(view)),
    caseButton,
    wordButton,
    regexpButton,
    replaceToggle,
    button("close", "Close (Escape)", () => {
      closeSearchPanel(view);
      view.focus();
    }),
  );

  const replaceOne = document.createElement("button");
  replaceOne.type = "button";
  replaceOne.className = styles.searchAction;
  replaceOne.textContent = "Replace";
  replaceOne.onmousedown = (event) => event.preventDefault();
  replaceOne.onclick = () => replaceNext(view);

  const replaceEvery = document.createElement("button");
  replaceEvery.type = "button";
  replaceEvery.className = styles.searchAction;
  replaceEvery.textContent = "All";
  replaceEvery.onmousedown = (event) => event.preventDefault();
  replaceEvery.onclick = () => replaceAll(view);

  replaceRow.append(replaceInput, replaceOne, replaceEvery);
  dom.append(row, replaceRow);

  const showCount = (state: EditorState) => {
    const query = getSearchQuery(state);
    if (!query.search) {
      count.textContent = "";
      dom.removeAttribute("data-no-match");
      return;
    }
    const { total, index } = countMatches(state, query);
    count.textContent = total > MAX_COUNT ? `${MAX_COUNT}+` : total ? `${index}/${total}` : "0/0";
    dom.toggleAttribute("data-no-match", total === 0);
  };
  showCount(view.state);

  return {
    dom,
    top: true,
    mount: () => showCount(view.state),
    update: (update) => {
      const requeried = update.transactions.some((tr) =>
        tr.effects.some((effect) => effect.is(setSearchQuery)),
      );
      if (update.docChanged || update.selectionSet || requeried) showCount(update.state);
    },
  };
}

export const searchPanel = search({ top: true, createPanel });
