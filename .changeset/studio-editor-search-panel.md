---
"conductor-studio": minor
---

Replace the editor's Cmd-F panel with a proper find bar.

`basicSetup` binds Mod-f but never configures search, so the editor fell back to
CodeMirror's built-in panel: an unstyled form of native checkboxes and buttons
in a box at the bottom of the editor. It now uses a custom panel that pins to
the top of the editor and matches the rest of Studio — a search field with a
live `3/12` match count that turns red on no match, chevrons for previous/next,
and compact `Aa` / `ab` / `.*` toggles for case, whole-word and regexp.

Replace hasn't gone anywhere, just behind a toggle so the common case — find,
Enter a few times, Escape — is a single row. Enter finds the next match,
Shift+Enter the previous, Escape closes and returns focus to the editor.
