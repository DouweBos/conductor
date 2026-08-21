# @conductor/studio-ui

## 0.2.0

### Minor Changes

- eab890e: Add Conductor Studio, a desktop app for writing and managing Maestro tests with
  a live device stream and element inspector, an agentic test writer (a Claude Code
  agent that drives the app through conductor and reuses your Maestro subflow POMs),
  and Qase-style test case management.
- eab890e: Autocomplete Maestro flow YAML in the editor: commands where a step goes, that
  command's parameters inside its block (element-selector keys included), the
  header keys above the `---`, and env variables inside `${…}`. The vocabulary is
  transcribed from Maestro's own YAML command models, and env names are collected
  from every `env:` block and `${VAR}` in the flows directory plus its
  `config.yaml`, so a new flow can be written against the suite's existing
  parameters.
- eab890e: Add Maestro-Studio-style element picking to the device panel. An Inspect mode
  outlines every captured element over the live stream — hover highlights the
  smallest one under the cursor, clicking it lists the commands that fit it
  (tapOn, longPressOn, inputText, assertVisible, copyTextFrom, runFlow-when-visible)
  as ready-to-paste YAML you insert into the open flow. Selectors are offered
  accessibility id first, then text (indexed when it isn't unique), then a
  percentage coordinate — and coordinates only for tap-like commands, since an
  assertion can't match a point. tvOS gets remote keys instead of taps.
- eab890e: Catch broken flows before running them. A linter checks the flows directory
  against the command schema and the flow catalog — unknown commands and
  parameters, unknown header keys, `runFlow`/`runScript` paths and aliases that
  don't resolve, calls that omit parameters the subflow reads, `${…}` names
  nothing supplies, and test cases pointing at flows that no longer exist.
  Problems appear underlined in the editor as you type and in a Problems tab in
  the console.
- eab890e: Renaming a flow now repoints every flow that calls it, in the style each call
  site used — a config.yaml alias stays an alias, a relative path stays relative.
  Previously a rename left all callers dangling, which in a POM suite silently
  breaks dozens of flows. Adds "Find usages" to the flow menu, Cmd/Ctrl-click on a
  `runFlow`/`runScript`/`file` line to open what it names, and project-wide search
  across the flows directory.
- eab890e: Make the workbench layout draggable: the flow sidebar and device column resize
  horizontally, the console resizes vertically, and both remember their sizes
  between sessions. `SplitPane` gained a `flexIndex` so a middle panel can absorb
  the slack (the editor, between two fixed columns), clamps a drag so no panel can
  be squashed past its minimum, and takes a `storageKey` to persist sizes.
- eab890e: Run one step of a flow without running the whole thing. Hovering the editor
  reveals a play button in the gutter beside every step; clicking it runs just that
  step, and the chevron next to it offers "Run all until here", which runs every
  step up to and including that one. Both keep the flow's header so `appId` and its
  `env` defaults still apply, and both honour the toolbar's run options.

### Patch Changes

- eab890e: Size the workbench panels as a share of the window instead of fixed pixels, so
  the first render is proportional on any display.
