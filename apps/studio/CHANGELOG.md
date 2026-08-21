# conductor-studio

## 0.3.0

### Minor Changes

- 2cdd1f4: Adopt Qase's model for test cases, and remove test cases from the CLI.

  **This minor release removes commands.** Released as a minor rather than a
  major by choice; if you automate against `conductor cases`, read the
  breaking notes below before upgrading.

  A case is now a Qase case entity — `id`, `title`, `description`,
  `preconditions`, steps as `action`/`data`/`expected_result`, `suite_id`,
  `severity`/`priority`/`type`/`behavior`/`status`, `custom_fields` and a flat
  `tags` list — written to YAML with Qase's own field names and its enums spelled
  out rather than left as the integers the API sends. Conductor's homegrown fields
  (`userStory`, `altIds`, dimension-map `tags`, `owner`, `state`, `links`) are
  gone. The one non-Qase addition is a `conductor:` block holding what Qase has no
  concept of: the flow that implements the case, and each step's page object.

  Studio can now mirror cases from **Qase**. Set the datasource per project from
  the Cases toolbar, paste an API token (stored encrypted via Electron's
  `safeStorage`; `QASE_API_TOKEN` overrides it) and sync. Qase owns case content
  and wins on every sync, but the `conductor:` block is re-attached, a page object
  that could not be re-attached is reported rather than dropped, and a case Qase no
  longer returns is marked `deprecated` rather than deleted — deleting it would
  take its flow link with it. Qase-owned fields become read-only in the editor.
  Matrix columns come from a Qase custom field of your choosing, falling back to
  the suite. Projects left on `local` keep authoring cases in Studio as before.
  Results now carry Qase's shape (`case_id`, `status` including `invalid`,
  `time_ms`, `comment`, per-step statuses) plus `app_version`, so pushing them to a
  Qase test run later is a small addition rather than a remap.

  **Breaking:** `conductor cases` (`list`, `report --junit`, `result`) is removed,
  along with the `conductor-test-cases` skill — `conductor init --force` prunes it
  from repos that have it. The CLI is for device control and app debugging; test
  cases are Studio's, and Studio's MCP server is how an agent reaches them, now via
  `list_test_cases`, `describe_test_case`, `get_cases_datasource`,
  `sync_test_cases`, `scaffold_case_flow`, `link_case_flow` and
  `record_case_result`. `cases report --junit` has no replacement: it existed only
  to ingest a CI run, and Studio is a local test-engineering tool.

  **Breaking:** there is no migration. Existing case files and `results.jsonl`
  records are not read by this version.

## 0.2.0

### Minor Changes

- eab890e: Agentic testing: the agent verifies a described behaviour on a device while you
  watch the plan tick over as a live checklist, and files a visual report — plan, every expectation with the evidence that decided it, the
  step timeline with screenshots, and a PASS / FAIL / BLOCKED verdict — as a
  self-contained HTML + PDF, read on a new Reports screen without leaving Studio
  and copyable as Markdown for a PR or an issue. Studio captures the evidence
  itself when an expectation resolves, outlining the element the check was about. A report against a
  test case records an execution on the matrix, a case can be handed to the agent
  from its detail pane, and a report leads on to a re-run or a reusable flow.

  Studio stamps the run's times and device itself and reconciles the verdict
  against the evidence, so a PASS over a failed check — or with nothing asserted —
  is corrected in the report rather than published as proof.

- eab890e: `list-devices` now reports a `formFactor` for Android devices (`tv` or
  `handset`), read from `ro.build.characteristics` for booted devices and from the
  AVD name for available ones. Android reports TVs, phones and tablets alike as
  `android`, so nothing downstream could tell them apart — a TV test could be sent
  to a phone emulator. Studio uses it to pick the right device for a flow and to
  offer tvOS and Android TV as separate choices.
- eab890e: Turn Studio's test cases from a read-only matrix into test case management:
  authoring, structured steps that name the page object automating them (so a flow
  can be scaffolded from a case and checked against it), an execution log fed by
  flow runs, manual verdicts, the agent and CI, test plans that run a selection on
  a device, and CSV import/export. Cases and results live under
  `~/.conductor/studio`, not in the repo under test, and results are local only —
  there is no CI sync. Adds `conductor cases
list | report | result` so CI can file JUnit results without Studio running.
- eab890e: Add Conductor Studio, a desktop app for writing and managing Maestro tests with
  a live device stream and element inspector, an agentic test writer (a Claude Code
  agent that drives the app through conductor and reuses your Maestro subflow POMs),
  and Qase-style test case management.
- eab890e: Let a long-running client hold a device reservation. `device-pool --acquire`
  stamped the claim with the CLI's own PID, and conductor frees claims whose owner
  has exited — so the reservation was gone the instant the command returned, and
  nothing could actually reserve a device. It now takes `--owner <pid>` to hold the
  claim for a process that sticks around, and `--device <id>` to claim a specific
  device instead of any free one, failing if someone else holds it.

  Conductor Studio uses this: an agent reserves its device for the length of the
  session and releases it however the session ends, refuses to start on a device
  another agent holds, and marks reserved devices in the picker.

- eab890e: Flow runs now reserve their device too, not just agent sessions — a run sharing a
  device with another agent tests whatever that agent left on screen. Claims are
  counted, so an agent and a run on the same device share one claim and the device
  is only released when the last of them finishes. `device-pool --acquire` is also
  re-entrant: re-claiming a device you already hold succeeds instead of reporting a
  conflict with yourself.
- eab890e: Suggest an `assertVisible … focused: true` for a focused element.

  On a focus-driven UI "is it visible" is the weaker half of the check — the point
  of a D-pad flow is that focus landed where you meant it to. Picking a focused
  element now offers that assertion alongside the plain one, using the `focused:`
  selector the resolver already supports on every platform. An unfocused element
  gets the inverse, `focused: false`, but only on tvOS — there exactly one element
  holds focus, so "not this one" is a real check, while on touch it would pass
  without testing anything.

  Fixes the state that made this visible in the first place: `traits` is
  `[type, ...states]`, so an element whose type has no mapping took its _state_ as
  its role — which is why plain containers read as "disabled" or "focused" as
  though that were what they are. Role now skips the state traits, and focus is
  carried as its own field (iOS `hasFocus`, web `focused`, Android `state.focused`).

- eab890e: Ship the conductor CLI with Studio instead of hunting for one on `PATH`.

  Studio previously resolved `CONDUCTOR_BIN`, then `conductor` on `PATH`, then the
  workspace build — which meant a packaged app was only usable by someone who
  already had the CLI installed globally, at whatever version happened to be
  there. It now bundles a self-contained tree, following the same approach Argus
  uses: `scripts/prepare-conductor.ts` installs a pinned published version into
  `native/conductor/` at postinstall, and an `afterPack` hook copies it into the
  packaged app's `Resources/`. PATH lookup is gone.

  The driver binaries stay lazy — the npm package carries no `drivers/`, so the
  CLI still downloads them on first use and the bundled tree remains pure
  JavaScript, which is what keeps `Resources/` notarizable.

  Settings gains a **Conductor version** picker: pin any published version at or
  above the bundled one and Studio installs it into `<userData>/conductor/<version>/`
  on demand, no app update required. The pin is stored separately from
  `settings.json` so a corrupt settings blob can't strand the app, and a failed
  install falls back to the bundled tree.

  For development against unpublished CLI changes, `CONDUCTOR_LOCAL` points the
  prepare script at a local checkout and links its built drivers in — replacing
  the old `CONDUCTOR_BIN` escape hatch.

- eab890e: Close the gap between running a flow in Studio and running the suite in CI.
  Run options gain saved **profiles**, so the env a suite always needs (`APP_ID`,
  platform) is picked rather than retyped; a **tag picker** built from the tags the
  flows actually declare; and a **flakiness check** that runs one flow N times and
  reports the pass rate. Adds **Run changed**, which runs the flows you touched
  against `main`, sharded runs (`--shard-split` on maestro, `run-parallel` on
  conductor), and Boot / Install-a-build controls on the device panel.
- eab890e: Sync test-case CI status from GitHub Actions via the `gh` CLI, and correct
  Conductor Studio's CLI contracts against the live conductor: bootable devices now
  appear in the picker, capture-ui frames read the `w`/`h` fields (element bounds
  were zero-sized), the inspector rebuilds the real hierarchy from `nodeId`, taps
  pass 0–1 fractions so they land on the right point, folder runs on the conductor
  engine run each flow in sequence, and the step checklist tracks maestro's
  `… COMPLETED/FAILED` and conductor's `→ … ok/FAILED` lines instead of guessing.
- eab890e: Close the loop between a failing run, CI, and the agent. Test cases now take
  their status from the **JUnit report** a CI run uploads — a per-flow result with
  the failure message — instead of matching job names, and a workflow can be
  triggered from Studio. A failed run gets an **Ask the agent to fix it** button
  that opens the agent with the failing step, the paths to maestro's screenshot
  and screen hierarchy for that moment, and the output tail already composed.
  Record mode can now capture an `assertVisible` for the current screen, so a
  recording asserts something rather than only tapping.
- eab890e: Replace the editor's Cmd-F panel with a proper find bar.

  `basicSetup` binds Mod-f but never configures search, so the editor fell back to
  CodeMirror's built-in panel: an unstyled form of native checkboxes and buttons
  in a box at the bottom of the editor. It now uses a custom panel that pins to
  the top of the editor and matches the rest of Studio — a search field with a
  live `3/12` match count that turns red on no match, chevrons for previous/next,
  and compact `Aa` / `ab` / `.*` toggles for case, whole-word and regexp.

  Replace hasn't gone anywhere, just behind a toggle so the common case — find,
  Enter a few times, Escape — is a single row. Enter finds the next match,
  Shift+Enter the previous, Escape closes and returns focus to the editor.

- eab890e: Autocomplete Maestro flow YAML in the editor: commands where a step goes, that
  command's parameters inside its block (element-selector keys included), the
  header keys above the `---`, and env variables inside `${…}`. The vocabulary is
  transcribed from Maestro's own YAML command models, and env names are collected
  from every `env:` block and `${VAR}` in the flows directory plus its
  `config.yaml`, so a new flow can be written against the suite's existing
  parameters.
- eab890e: Add ⇧⌘F for search across every flow, and jump to the matching line.

  The sidebar could already search all flows, but only if you found the field, and
  clicking a hit opened the file at the top — you were told `login.yaml:47` and
  then had to scroll to 47 yourself. ⇧⌘F now focuses the field from anywhere in
  the workbench, Escape clears it, and picking a hit opens the file and selects
  that line.

  The result list also says how many matched, and says so explicitly when it
  stopped at the 200-hit cap rather than looking like that was all of them.

- eab890e: Right-click an element in inspect mode to pick from the hierarchy under it.

  The smallest box under the cursor wins the pointer, which is right for picking a
  label but leaves the row, cell or container that holds it unreachable — you had
  to hunt for it in the inspector tree. Right-clicking now lists every element
  whose bounds cover that point, innermost first and indented by depth, and
  hovering an entry highlights it on the device before you commit.

- eab890e: Add Maestro-Studio-style element picking to the device panel. An Inspect mode
  outlines every captured element over the live stream — hover highlights the
  smallest one under the cursor, clicking it lists the commands that fit it
  (tapOn, longPressOn, inputText, assertVisible, copyTextFrom, runFlow-when-visible)
  as ready-to-paste YAML you insert into the open flow. Selectors are offered
  accessibility id first, then text (indexed when it isn't unique), then a
  percentage coordinate — and coordinates only for tap-like commands, since an
  assertion can't match a point. tvOS gets remote keys instead of taps.
- eab890e: Show the whole view hierarchy in the inspector, not just the a11y snapshot.

  Elements that a CLI `assert-visible` found were missing from Studio's tree. The
  inspector was built from `capture-ui`'s flat `a11ySnapshot`, which only holds
  nodes a screen reader stops on — a container carrying an accessibility
  identifier, exactly the thing selectors target, was never in it. The tree now
  comes from the platform hierarchy, which also carries identifiers directly
  instead of the old trick of matching them back on by rounded frame. That trick
  only read `hierarchy.axElement`, so on Android and web identifiers never
  resolved at all.

  Rows lead with the identifier too — one showing only its role read as an
  anonymous "Element" even when it had one.

  `@eN` refs still come from the snapshot, joined on the `nodeId` path. Nodes
  without one are marked non-a11y, which keeps the device overlay to the same
  handful of boxes as before and leaves scene-graph signatures unchanged.
  Right-click on the device still reaches the containers around them.

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
- eab890e: Keep run history, and show maestro's debug output for a failed run. Runs are
  recorded per project with their status, timing and output tail; opening one
  reads `~/.maestro/tests/<run>/` and lists every executed command with its
  status, duration, the screenshot taken at that step and the screen hierarchy
  captured with it — which is what actually explains a failure. Adds a repeat run
  that runs a flow N times and reports the pass rate, for checking flakiness.
- eab890e: Run one step of a flow without running the whole thing. Hovering the editor
  reveals a play button in the gutter beside every step; clicking it runs just that
  step, and the chevron next to it offers "Run all until here", which runs every
  step up to and including that one. Both keep the flow's header so `appId` and its
  `env` defaults still apply, and both honour the toolbar's run options.
- eab890e: Complete subflows where a step goes, since a POM suite is written by chaining
  them: typing `details/open` offers `@pages/details/open.yaml`, and accepting it
  writes the whole `runFlow` — the file in its config.yaml alias form, plus the
  `env:` block of every parameter the subflow expects, with tab stops in the
  values. Parameters are inferred from the subflow's own `${…}` usage, so they're
  found whether or not it declares them. Path parameters (`file`, `files`, `path`,
  `script`) complete from the flows directory too, in both alias and relative form.
- eab890e: Tab the inspect-mode command suggestions instead of stacking them.

  Picking an element produced one flat scroll of every command × every selector —
  on tvOS that's six remote keys before you reach the first assertion. They're now
  grouped into Press/Tap, Assert, Scroll and Other, and the panel shows one group
  at a time. The chosen tab sticks as you pick different elements, and groups with
  nothing in them don't get a tab.

  Adds two commands the list was missing: `assertNotVisible`, and
  `scrollUntilVisible` in each of the four directions. Scroll is a swipe, so it's
  offered on touch platforms only — a TV moves focus instead.

- eab890e: Give folders a real context menu in the flow tree, and scaffold new flows from
  templates.

  Right-clicking a folder offered nothing you could do to a folder — no way to add
  a file to it, which is the one thing a file tree is for. Folders now get the same
  menu as files: new flow / new folder here (prefilled with the folder, or with a
  file's parent), rename, duplicate, copy relative / aliased / absolute path,
  reveal in Finder, delete. Renaming a folder repoints every reference to the files
  inside it, and duplicating one copies its contents.

  **New flow** now scaffolds from a template — blank, page object subflow or tagged
  case out of the box, plus whatever the project puts in
  `<flowsDir>/.templates/<id>.yaml.tmpl`. Templates are flows with
  `{{placeholders}}`, since `${…}` already belongs to Maestro at run time; `name`,
  `path`, `dir`, `date` and `appId` fill themselves in, and any other `{{var}}`
  becomes a field in the dialog. The `.tmpl` suffix keeps templates out of runs
  without a `config.yaml` exclusion — every flow scanner matches on a
  `.yaml`/`.yml`/`.js` extension.

- eab890e: Drive tvOS from the device stream, and record the remote into the flow.

  A TV is focus-driven, so the two gestures Studio could record — tap and swipe —
  were exactly the two that mean nothing on one, and nothing in Studio called
  `press-key` at all. For a tvOS device the stream now becomes a remote instead of
  a touch surface: it takes keyboard focus, arrow keys drive the D-pad,
  Enter/Space selects, Esc/Backspace is Menu, and in Record mode each press is
  appended to the open flow as a `pressKey` step.

  Auto-repeat is ignored, so holding a key is one press and one step — the
  recorded flow always matches what actually happened on the device. Long presses
  aren't recorded: a flow's `pressKey` takes a bare key and Maestro's is
  scalar-only, so a held press could be performed but never replayed faithfully.

### Patch Changes

- eab890e: Select the neighbouring tab when you close the active one.

  Closing a tab only dropped it from the open list. The open file lives in the
  URL, which still pointed at the file that just closed, so the editor stayed
  mounted with no buffer behind it — a tab bar over an empty pane.

  Closing the active tab now moves to the tab on its left, or the one on its right
  when it was the first, and falls back to the "no flow open" state when it was
  the last. Closing a background tab leaves your current file alone.

- eab890e: Stop reporting a draft case's unwritten flow as an error.

  A matrix is imported ahead of the flows, so most cases name a flow nobody has
  written yet — which the project check reported as an error per reference, one
  or two per case. That buried the problems worth acting on under a list of
  planned work.

  A case tagged `status: draft` now reports its missing flow as info, worded as
  what it is: not written yet. A case that doesn't claim to be a draft still
  errors, since that one really is pointing at nothing.

- eab890e: Find the flows directory anywhere in the repo, not just at its root. Studio now
  searches four levels deep for a `.maestro`/`maestro` folder that actually holds
  flows, so a monorepo keeping them per-app (`apps/plex/.maestro`) no longer reads
  as "No flows yet". The sidebar names the directory it's showing, and offers a
  picker when the repo has more than one.
- eab890e: Show only matching elements when searching the inspector.

  Filtering kept the ancestors leading to each hit, so the tree still nested and
  you read past several wrapper rows to reach the element you were after — and the
  match count included those ancestors, so it never matched what you could see.
  A search now lists just the elements that match, and the count is the number of
  them.

  A hit that sits inside another hit keeps its nesting; only the non-matching
  nodes between them are dropped. Clearing the filter brings the hierarchy back.

- eab890e: Make Cmd-clicking a flow reference actually open it, and show it as a link.

  Go-to-definition was already wired up but silently dead: `flowRefs` imported
  `node:path`, which Vite externalizes for the renderer, so `resolveReference`
  threw on every Cmd-click and you were left hunting for the POM by hand. The
  path handling is now hand-rolled posix, shared unchanged with the main process.

  Holding Cmd/Ctrl also underlines the reference under the pointer and only
  follows a click on the token itself, so a suite's subflows read as links instead
  of being an invisible affordance you have to already know about.

- eab890e: Tag the inspector's elements that are actually on screen.

  A capture holds the whole hierarchy, so a scroller's offscreen rows and
  collapsed views sit in the tree looking exactly like the ones you can see —
  and an assertion written against one of those is a flaky test. Rows whose box
  intersects the screen now carry an "in view" badge beside their `@eN` ref.
  Partially visible counts; zero-sized and boundless elements don't.

- eab890e: Show the element search in inspect mode until you've picked something.

  Inspect mode with nothing selected was a "Pick an element" placeholder, so the
  searchable tree — the fastest way to find an element that's offscreen or buried
  — was only reachable by switching back to interact mode. The panel now falls
  back to the inspector, and swaps to the command list once you pick an element on
  the device or in the tree. Clearing the selection returns you to the search.

- eab890e: Size the workbench panels as a share of the window instead of fixed pixels, so
  the first render is proportional on any display.
- eab890e: Collapse hierarchy nodes that carry no identity.

  Building the inspector from the full view hierarchy brought the layout wrappers
  with it — no identifier, no text, no a11y, nothing to select on. A native
  hierarchy is mostly single-child wrappers, so the tree and the right-click stack
  filled with hundreds of rows named after their own node path.

  A node with no identifier, no text and no a11y ref is now spliced out and its
  children take its place. A wrapper that branches is kept, since it's the only
  thing grouping its children, and it reads as "Group" rather than `#0.0.0.0.…`.

- eab890e: Record an assertion on the focused element, on TV only.

  The Assert button appended an `assertVisible` for the largest labelled element
  on screen — a proxy for "which screen am I on" that got worse once the capture
  started carrying the full view hierarchy, since the largest labelled node is
  then the app window itself.

  On a TV focus _is_ the state of the screen, so it now records
  `assertVisible … focused: true` against whatever holds focus: the deepest
  focused element that has an id or a label, matching how the resolver picks
  between a focused container and the focused element inside it. The button only
  shows for tvOS devices, since elsewhere there's usually nothing focused to
  assert on.

  The step goes through the YAML writer rather than string interpolation, so a
  title containing a colon or a quote comes out escaped instead of producing a
  step that won't parse.

- eab890e: Give Studio its own release tag and update feed, separate from the CLI's.

  Studio's releases share the conductor repo with the CLI, which publishes
  `v<version>` tags. electron-builder defaults to that same tag shape, so
  publishing Studio would have uploaded its dmg into an existing CLI release the
  moment the versions overlapped. Studio now tags `studio-v<version>`.

  That prefix also rules out electron-updater's github provider, which resolves
  the stable channel through a repo-wide `/releases/latest` — in this repo, a CLI
  release carrying no channel manifest. Studio moves to the `generic` provider
  behind `https://houwert.dev/conductor/studio/updates`, a Cloudflare Pages
  Function that filters to `studio-v` tags and resolves each channel to the
  newest release in its tier. Requires the companion function in the houwert.dev
  repo.

  The release channel now comes from the version itself — `0.2.0-beta.1`
  publishes to beta as a GitHub prerelease, `0.2.0` to stable — so the workflow's
  channel input is gone; bump the version and run it. Artifacts are also renamed
  to `conductor-studio-<version>-<arch>.<ext>`, since GitHub rewrites the space in
  `Conductor Studio` and broke the URLs recorded in the channel manifest.

- eab890e: Run whole steps from a selection, not the raw selected text.

  "Run selection" sent exactly the characters you had highlighted, so a selection
  ending on a `- assertVisible:` line without the indented `id:` beneath it wrote
  a command with no value — which Maestro rejects with
  `Incorrect Command Format: assertVisible`, pointing at the end of the truncated
  line rather than at anything you could see was wrong.

  The selection is now rounded out to every step it touches, so partially covering
  a step runs that step. Parking the cursor inside a step body and hitting Run
  selection runs that step too. A selection that touches no steps does nothing
  instead of failing.

- eab890e: Let deep tree rows scroll horizontally instead of collapsing to dots.

  Rows were capped at the container width, and the label was the only part
  allowed to shrink — so past a few levels of nesting the indentation ate all of
  it and a row rendered as a twisty, a dot and its `@eN` badge, with nothing to
  say which element it was. The tree now sizes to its widest row, so the panel
  scrolls far enough to read them.

  Labels no longer ellipsise, which also applies to the flow sidebar's file tree:
  a long filename now scrolls into view rather than being cut short. Both trees
  already sat in scrollable panels, so nothing is clipped out of reach.

- eab890e: Highlight the device element you're hovering in the inspector list.

  Hovering a row in the element search (or the hierarchy) now outlines that
  element on the device stream, the same highlight you get hovering the device
  itself — so you can tell which of four similarly-named rows is the one you
  want without clicking each in turn. The highlight clears when the panel swaps
  out mid-hover, which never fires a mouseleave.

- eab890e: Give inspector rows enough context to tell duplicates apart.

  Two rows reading `Element "Continue Watching"` — a container and the text inside
  it — were indistinguishable. Rows now carry their size, which is the thing that
  separates a row-wide container from the label it wraps.

  Roles were also missing on iOS and tvOS, which is why everything read as
  "Element": the hierarchy node carries `traits`, and only the flat snapshot entry
  has a `role` derived from the first one. The mapper reads the traits directly
  now, so rows say `staticText`, `button`, `window` again.

- eab890e: Stop the tvOS remote hint reading as a fake dynamic island.

  "Click to use the remote" was a dark, pill-shaped overlay floating over the TV
  picture — on Apple TV content it looked like a device artifact rather than a
  Studio hint. It was also unreadable in the dark theme: the text used
  `--text-inverse`, which is near-black there, on a near-black scrim.

  It's now a StatusPill beside the `live · 1920×1080` label under the frame, so
  it's outside the picture entirely and legible in both themes. It also hides in
  inspect mode, where clicking the screen picks elements and the remote isn't what
  a click does.

- eab890e: Fix the device stream never rendering. The daemon sends bare IDR access units
  with the SPS/PPS only in the config frame, so a decoder configured for Annex B
  had no parameter sets and never produced a picture. Studio now rewrites each
  access unit to AVCC and configures the decoder with the avcC `description` — the
  same path Argus's device streams use — and adopts its keyframe resync, decode
  backpressure and structured-clone handling. Connect failures also report
  themselves: the stream-server timeout covers a cold daemon boot, and socket
  errors surface in the device panel instead of leaving a spinner up forever.
- Updated dependencies [eab890e]
- Updated dependencies [eab890e]
- Updated dependencies [eab890e]
- Updated dependencies [eab890e]
- Updated dependencies [eab890e]
- Updated dependencies [eab890e]
- Updated dependencies [eab890e]
- Updated dependencies [eab890e]
  - @conductor/studio-ui@0.2.0
