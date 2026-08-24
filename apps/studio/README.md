# Conductor Studio

A desktop app (Electron + React) that sits on top of the conductor CLI. It does
three jobs: writing and managing Maestro tests, writing them with an agent, and
tracking them as test cases. Light and dark, notarized, auto-updating.

It lives in this monorepo at `apps/studio`, on a shared design system at
`packages/studio-ui` (`@conductor/studio-ui`).

---

## Opening a project

Studio opens the enclosing git repository (override with `STUDIO_PROJECT_ROOT`,
or pick one from the title bar). It then finds the flows directory by searching
**four levels deep** for a `.maestro`/`maestro` folder that actually holds flows
— judged by a flow's shape, an `appId:` header or a `---` separator, so a
`.github/actions/maestro` full of workflow YAML doesn't count. Monorepos that
keep flows per-app (`apps/plex/.maestro`) are found. The sidebar names the
directory it settled on, and offers a picker when a repo has more than one.

Studio ships its own conductor CLI, so nothing needs to be installed globally —
and a stray `conductor` on `PATH` is never used. Settings → **Conductor version**
pins a different published version, which Studio installs on demand. See
[Bundled conductor CLI](#bundled-conductor-cli).

## 1. The Maestro workbench

A three-column workbench: flow tree, editor, device. Every divider is draggable
— the sidebar and device columns horizontally, the console and the device
panel's inspector vertically — and the sizes are remembered between sessions.

### Flow tree

The project's flows, with a right-click menu to **rename / duplicate / delete /
add folders / find usages / copy paths / reveal in Finder**, **New flow** from a
template, and a search box that greps the whole flows directory. Folders get the
same menu, plus "new flow / new folder here"; renaming or duplicating one takes
its contents with it.

**Renaming repoints every caller.** A POM suite refers to a subflow from a dozen
places (`commands/launch/launch.yaml` has 36 callers in the Plex suite), so a
rename rewrites each reference in the style that call site used — a config.yaml
alias stays an alias, a relative path stays relative. **Find usages** answers
"what breaks if I change this", and Cmd/Ctrl-clicking a `runFlow`/`runScript`/
`file` line in the editor opens what it names.

#### Flow templates

**New flow** scaffolds from a template. Studio ships a few (blank, page object
subflow, tagged case); a project overrides or adds its own by dropping files in
`<flowsDir>/.templates/<id>.yaml.tmpl`. The template's first `#` comment line is
its description in the dialog.

A template is a flow with `{{placeholders}}` — `${…}` is Maestro's at run time,
so scaffolding needs its own syntax. `name`, `path`, `dir`, `date` and `appId`
(inferred from what the suite's flows already declare) are filled in
automatically; every other `{{var}}` becomes a field in the New-flow dialog.
Placeholders left unanswered stay in the file, where they read as "fill me in".

The `.tmpl` suffix is load-bearing: every flow scanner — maestro's workspace
glob, Studio's folder runner, the file tree — matches on a `.yaml`/`.yml`/`.js`
extension, so templates stay out of runs without any `config.yaml` exclusion.

### Editor

CodeMirror, YAML and JS, with tabs and ⌘S to save.

**Autocomplete** covers the whole vocabulary, driven off indentation:

| Where | What it offers |
| --- | --- |
| `- ta⎸` | 45 commands, each with a one-line doc |
| `- tapOn:` → `  i⎸` | the 27 element-selector keys — `id`, `index`, `point`, `below`, `childOf`, … |
| `- launchApp:` → `  clear⎸` | that command's own parameters |
| above the `---` | `appId`, `name`, `tags`, `env`, `onFlowStart`, `onFlowComplete` |
| `"${US⎸"` | env variables, including inside quoted strings |
| `details/open⎸` | **subflows** — see below |
| `file:`, `files:`, `path:`, `script:` | paths from the flows directory, alias and relative form |

The command and parameter names are transcribed from Maestro's own YAML models
(`YamlFluentCommand` and the `Yaml*` classes), so they match what the parser
accepts rather than what the docs describe. Env names are collected from the
whole flows directory: every `env:` block, every `${VAR}` already referenced,
and `config.yaml`.

**Subflow completion** is the one that matters for a POM suite, where flows are
written by chaining subflows. Typing a path fragment where a step goes offers
the matching flow, and accepting it writes the whole call:

```yaml
- runFlow:
    file: "@pages/details/open.yaml"
    env:
      path: ⎸
      expectScreen: ⎸
```

The file uses its `@alias/…` form when `config.yaml` declares one (resolved the
way conductor's `resolvePath` does — longest alias wins), else a path relative to
the flow you're editing. The `env:` block lists every parameter the subflow
expects, with tab stops in the values. Parameters are **inferred from the
subflow's own `${…}` usage** — lower-camelCase names, since SCREAMING_SNAKE ones
are suite-wide globals passed on the command line and dotted ones are script
output — so they're found whether or not the flow declares them. Scripts get
`runScript:` instead.

### Problems

A linter checks the suite without running it, against the same command schema
and flow catalog that drive autocomplete: unknown commands and parameters,
unknown header keys, `runFlow`/`runScript` paths and aliases that don't resolve,
calls that omit parameters the subflow reads, `${…}` names nothing supplies, and
test cases pointing at flows that no longer exist. Problems underline in the
editor as you type and collect in the **Problems** tab.

It knows two things about how Maestro actually behaves, which keep it quiet on a
healthy suite: an `env:` block is a sibling of `file:`, not a child, and env is
inherited into subflows — so a subflow forwarding to another doesn't have to
restate anything.

### Running flows

Studio prefers the system-installed **`maestro`** binary (`maestro test`) and
falls back to **`conductor run-flow`** when maestro isn't on `PATH`. The console
labels which engine ran. (Conductor's flow YAML is a subset of Maestro's.)

Every run — and every agent session — **reserves its device** in conductor's
shared pool first, so a second agent can't tap through the app mid-test. The
claim is handed back however the run ends, and a run on a device somebody else
holds is refused rather than raced.

- **Run** the open flow, **Run selection** (the highlighted steps, inline), and
  **Run all** (the flows folder — expanded to one run per flow on the conductor
  engine, which takes a single file at a time).
- **Run options**: environment variables (`--env`) and include/exclude tags.
  These apply to inline runs too.
- **Per-step runs**: hover the editor and a play button appears in the gutter
  beside every step. Click it to run just that step; the chevron next to it
  offers **Run all until here**, running every step up to and including that
  one. Hovering either control highlights exactly the lines it would run. A step owns the lines indented under it, so multi-line commands run
  whole, and the slice keeps the flow's header so `appId` and its `env` defaults
  still apply.
- A **step checklist** ticks off each step live, parsed from what the engines
  actually print (`… COMPLETED`/`FAILED` for maestro, `→ … ok`/`FAILED` for
  conductor), plus a **screenshot captured automatically on failure**.
- A **REPL** with two modes: `conductor` runs a raw CLI command and prints the
  output in the console; `maestro` runs a YAML step inline against the device and
  shows it in the step list.
- A **Logs** tab streaming `conductor logs` for the connected device.
- **Run changed** runs only the flows you touched against `main` (committed and
  working-tree alike).
- **Run options** live in the title bar, not in the open flow: env variables,
  tags and the chosen profile belong to the session, so a single flow, a folder
  run and a case run all carry the same setup, and they survive closing the last
  tab. They carry saved **profiles**, so the env a suite always needs
  (`APP_ID`, platform) is picked rather than retyped; a **tag picker** built from
  the tags the flows declare; a **shard count** (`--shard-split` on maestro,
  `run-parallel` on conductor); and a **flakiness check** that runs one flow N
  times and reports the pass rate.

### Runs

Every run is recorded per project — status, timing, output tail — so "it passed
ten minutes ago" is answerable. Opening a maestro run reads the debug output it
writes to `~/.maestro/tests/<run>/`: every executed command with its status and
duration, the **screenshot** taken at that step, and the **screen hierarchy**
captured with it. That's what explains a failure; a console scroll doesn't.

A failed run has **Ask the agent to fix it**, which opens the agent with the
failing step, the paths to that step's screenshot and hierarchy, and the output
tail already composed — loaded into the composer rather than sent, so you read
and edit it before the agent starts touching the app.

### Device panel

The mirror and inspector always go through conductor: the daemon's H.264 video
WebSocket (`conductor stream-server`) is decoded in the renderer with WebCodecs,
input goes through conductor's commands, and the inspector reads
`conductor capture-ui`.

Two modes:

- **Interact** — your taps and swipes drive the device. **Record** mode appends
  them to the open flow as Maestro steps, resolving taps to text/id selectors
  via `capture-ui`, and can capture an `assertVisible` for the current screen —
  a recording of nothing but taps passes against a completely broken app.
  **Boot** and **Install a build** run conductor's `start-device` and
  `install-app`, so getting a device ready doesn't mean leaving Studio.

  On **tvOS** there is nothing to tap — a TV is focus-driven — so the stream
  becomes a remote instead of a touch surface. It takes keyboard focus (arrow
  keys → D-pad, Enter/Space → Select, Esc/Backspace → Menu) and each press
  becomes a `pressKey` step. Auto-repeat is ignored: holding a key is one press
  and one step, so the flow always matches what you did. Long presses aren't
  recorded — the CLI can hold a button, but a flow's `pressKey` takes a bare key
  and Maestro's is scalar-only, so a held press could never replay faithfully.
- **Inspect** — Maestro-Studio-style element picking. Every captured element is
  outlined over the stream; hovering highlights the smallest one under the
  cursor, clicking it lists the commands that fit it — **tapOn / longPressOn /
  inputText / assertVisible / copyTextFrom / runFlow-when-visible** — as
  ready-to-paste YAML with an Insert button. Selectors are offered best-first:
  accessibility id, then text (indexed when the text isn't unique on screen),
  then a percentage coordinate. Coordinates only appear for tap-like commands,
  since an assertion can't match a point. On tvOS you get the remote keys
  instead, because `tap-on` isn't supported there at all. Picking in the
  inspector tree and picking on the stream are the same selection. The tree has
  a filter box — a capture runs to hundreds of nodes, so matching on id, text or
  role is the only way through it; matches keep the ancestors that lead to them
  so the hierarchy still reads.

## 2. Agentic test writing

A Claude Code wrapper that drives the app through conductor, reuses the repo's
Maestro **subflow POMs**, and is seeded with a **scene graph** of discovered
screens so later runs skip re-orientation. The device panel sits beside the
conversation, so you can watch the agent work.

The agent **reserves its device** in conductor's shared pool for the length of
the session, so a second agent — in Studio, in a terminal, or in another editor —
can't tap through the app half-way into a test. Starting an agent on a device
somebody else holds fails with who holds it rather than racing; the device picker
marks reserved devices, and the claim is returned however the agent ends.

The agent spawns the `claude` CLI with `--output-format stream-json
--input-format stream-json --permission-prompt-tool stdio`; the main process
parses the stream and forwards events to the renderer, which renders the
conversation (messages + tool calls) and handles tool-permission prompts. Its
system prompt describes the connected device, the conductor command surface, the
POM catalog and the known screens. Requires the
[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) on `PATH`.

The **scene graph** builds itself: every `capture-ui` — from the inspector, a tap
or a swipe — upserts a screen node keyed by a signature of the hierarchy, and the
preceding action becomes a transition edge. It's persisted to
`.conductor-studio/scenegraph.json` and fed into the agent's system prompt.

### Agentic testing & reports

The agent's other job is verifying a described behaviour — "check that adding a
movie to the watchlist shows it on the Watchlist screen" — without writing a
flow for it. It turns the sentence into a plan (preconditions, actions,
expectations), drives the device, and proves each expectation with a structured
check.

**You watch the test, not the transcript.** The plan goes up as a live checklist
beside the device the moment the agent declares it (`start_test_report`), and
each expectation ticks over as it resolves (`record_expectation`) — pending,
checking, ✓/✗ with the evidence line under it. The conversation below is the
transcript; the checklist is the test.

**Studio takes the evidence, the agent doesn't.** Recording an expectation
captures the device there and then, and naming the element the check was about
outlines it in that screenshot — so the report shows *"Remove from Watchlist"
was visible* with the button ringed, not a screen the reader has to search.
Nothing depends on the agent remembering to screenshot at the right moment.

The run ends as a **report** on the Reports screen: a filmstrip of every
captured moment, each expectation with the verbatim tool output that decided it
and its outlined screenshot, the step timeline, and a PASS / FAIL / BLOCKED
verdict. It opens **in Studio** (a sandboxed frame — the HTML is self-contained
and script-free), with **Copy as Markdown** for a PR or an issue, plus the PDF
and the raw folder when you want them. PDFs are printed by Electron's own
Chromium, so there's no headless-browser dependency.

**The report has to survive its own evidence.** Studio stamps the start/finish
times and the device from what it knows, because a model asked for a timestamp
invents one and an invented timestamp in an evidence document is worse than
none. It then reconciles the verdict: a PASS over a failed expectation becomes a
FAIL, and a PASS with nothing asserted becomes BLOCKED — the correction is
printed at the top of the report and returned to the agent.

It closes the loop with test cases. Handing a case to the agent (**Verify with
the agent**, on the case detail) sends it the business rule and steps; the
report it files records an execution on the matrix, so a case with no flow still
gets a result. From a report you can send the agent back for a re-run or ask it
to transcribe the run into a reusable flow.

Reports live in `~/.conductor/studio/reports/<project>/<test>-<timestamp>/`
alongside `run-log.json` and the screenshots — a run artefact, not something to
commit.

## 3. Test case management

A **case** follows **Qase's model** — id, title, description, steps as
action/data/expected_result, suite, severity/priority/type, custom fields, tags —
kept as a YAML file under `~/.conductor/studio/<project>/cases/`, scoped by the
project's path. Studio does not write cases, results or plans into the repo under
test: the flows a case names are the tests, and those are what belong in git. The
Cases screen is the matrix over them: a switchable custom field for the columns,
filters, search, and per-column automation coverage.

Cases are either **local** to this machine or **mirrored from Qase** — see
[Datasource](#datasource) below.

```yaml
id: 12
title: User can log in with valid credentials
description: As a returning user, I can sign in…
preconditions: A registered account exists.
severity: normal
priority: medium
type: functional
status: actual
suite: Authentication
custom_fields:
  Platform: [ios, android]
tags: [auth, p0]
external_issues: [https://linear.app/acme/issue/ABC-12]
steps:
  - action: Open the login screen
    expected_result: The email field is focused

conductor:
  flow: flows/cases/login.yaml
```

Everything above `conductor:` is Qase's, written with Qase's own field names and
its enums spelled out rather than left as the integers the API sends. The
`conductor:` block is the one thing Qase has no concept of — which flow file
implements the case, and which page object performs each step — so it is
Conductor's, and it survives every sync.

One user story is one case even when each platform implements it separately: use
`conductor.flows` instead of `conductor.flow` to name a flow per column. Each
column then reports its own result, and the case's own status is the worst of
them.

```yaml
id: 34
custom_fields:
  Platform: [tv, mobile]
conductor:
  flows:
    tv: flows/features/player/vod-playback.tv.yaml
    mobile: flows/features/player/vod-playback.responsive.yaml
```

### Datasource

A project's cases are either **local** — Studio owns them, you author them on the
Cases screen — or pulled from **Qase**, set per project under the datasource
button in the toolbar. In Qase mode:

- **Sync** pulls every case (optionally only certain suites) into the local
  store. Qase owns case content and wins on every sync; the `conductor:` block
  is read off the existing file and re-attached, and any page object that could
  not be re-attached because its step changed is reported rather than dropped.
- A case Qase no longer returns is marked `status: deprecated`, never deleted —
  deleting it would take its flow link with it. Only cases of the project being
  pulled are considered: a case written under another project code is another
  project's, not a missing one, so repointing a datasource no longer deprecates
  everything that was there before.
- Qase-owned fields are **read-only** in the editor. What stays yours is the
  automation wiring: the flow that implements the case, and each step's page
  object.
- The API token is stored per sub-project, encrypted with Electron's
  `safeStorage`. `QASE_API_TOKEN` in the environment overrides all of them.
- Once a token is entered the project code becomes a picker of the projects that
  token can see, so there is nothing to look up in Qase and retype.

**Sub-projects.** One repo can hold more than one app — a mobile app and a tv
app in the same monorepo — and each mirrors its own Qase project. The toolbar's
project picker switches between them, and **all projects** merges them for
reading. Each sub-project keeps its own:

- cases, plans and results, under
  `~/.conductor/studio/<repo>/<store>/<sub-project>/<local|qase>/`;
- Qase project code and API token;
- Maestro tag, which scaffolded flows are given so they land in that app's suite;
- default device, so a tv case doesn't open on whichever phone was last selected.

Mirrored and hand-written cases never share a store: a sub-project keeps
`local` and `qase` apart, so switching a sub-project to Qase doesn't bury the
cases it was authoring, and switching back returns them untouched. Which Qase
project a sub-project mirrors is the sub-project's business — repoint it and the
cases the old code pulled stay on disk, out of the matrix and out of every sync,
rather than being relabelled or deprecated.

Authoring is scoped to one sub-project: adding, importing and syncing are
disabled under **all projects**, because a new case has to land somewhere. An
install from before sub-projects existed keeps working — its datasource becomes
a sub-project called `default` and its cases move under it on first read.

The mirror is deliberate: the matrix re-reads cases constantly and lint runs on
every flow change, so neither should wait on a network round trip, and a flaky
connection should not stop a validation session.

**Authoring.** Cases are created, edited, renamed and deleted from the screen.
Edits go through yaml's Document API, so comments and key order in a
hand-written case survive a round trip. **Import** reads a CSV out of whatever
tool you're leaving — columns it recognises map to case fields, and the ones it
doesn't become custom fields, which is how a "Platform" column turns into the
matrix's columns. **Export** writes the whole matrix back out, automation status
and last verdict included.

**Executions.** A case is only as good as its evidence, so every verification
is appended to `results.jsonl` beside the cases. Four things write to it:

- **Flow runs** — finishing any run, anywhere in Studio, files a result for
  every case that names that flow.
- **People** — a case with no automation gets pass / fail / blocked / skipped
  with a note, straight from the case panel.
- **The agent** — its MCP tools (`list_test_cases`, `describe_test_case`,
  `record_case_result`) let it find unautomated cases, read the steps as a
  script, and file what it found; `write_test_report` takes a `caseId` so a
  report doubles as that case's result.

The panel shows the history, pass rate and a flaky flag (recent runs
disagreeing) per case.

**Steps are the bridge to automation.** A case's steps carry the page object
that performs them, which is what makes the human-readable case and the Maestro
flow behind it two views of one thing:

```yaml
preconditions: [Signed in with a fresh account]
steps:
  - action: Open the show's details page
    expected: The details screen loads
    pom: pages/details/open.yaml
    env: { path: show/3rd-rock, expectScreen: screen-show }
  - action: Play the first episode
    expected: Playback starts
    pom: pages/actionBar/markWatched.yaml
postconditions: [Delete the account]
```

From that, Studio can **scaffold the flow**: each step with a page object becomes
a `runFlow` call (in the project's `@alias` form) carrying its env, each step
without one becomes a TODO in the file, and the new flow is linked back onto the
case. Where the project keeps drafts out of CI with a `*-draft` tag, the scaffold
follows that convention rather than enrolling an unverified flow into the suite.

It reads the other way too: the case panel marks each step **automated**, **not
in flow** or **manual** by checking whether the linked flow reaches that page
object transitively, and says so when the flow calls page objects no step
accounts for. A step naming a page object that doesn't exist is a lint error,
like a case pointing at a missing flow.

**Writing the missing flow.** A case with no flow on a platform has a button
that hands it to the agent with a brief assembled from the repo rather than a
one-line instruction: the case (steps, expectations, pre/postconditions), **the
same case's flow on the other platform** in full — same assertions and test
data, only the interaction model differs — or a neighbouring flow for the house
style, every page object with its `env` parameters, and what the scene graph
knows about the app's screens. It's told to `scaffold_case_flow` first (skeleton
from the steps, page objects become `runFlow` calls, gaps become TODOs, linked
to the case), fill the gaps, run it until it's green twice, keep the draft tag
until then, and file a result. Two MCP tools back it: `scaffold_case_flow` and
`link_case_flow`.

**Grouping.** 150 rows is a list, not a table you can read, so the matrix bands
by a tag dimension — **area** by default, which is how a matrix is usually
written — with each band collapsible and carrying its own coverage
(`Community · 32 · 6/32 automated · 1 failing`). Inside a band, rows cluster by
sub-area, so a big group still has shape. Group by any dimension you tag with
(priority, owner, status), or turn it off for a flat list; collapsed bands are
remembered.

**Running stays here.** The ▶ on a cell runs that platform's flow and opens the
device rail beside the matrix: the flow's status, its current step, the tail of
its output, and the screen it's happening on. Nothing jumps to the editor — the
case is what you're working on, not the file behind it.

Which device a flow runs on comes from the flow's own `tags:` — the same thing
the suite configs select on, so a `tv`-tagged flow wants a TV and a
`responsive`-tagged one wants a phone (`-draft` variants count; `common` flows
defer to the column you clicked). Because Android reports TVs, phones and
tablets all as `android`, conductor now also reports a form factor, so "tv"
means tvOS **or** Android TV and never an Android phone. Each column header
carries a device picker — that's where you choose between an Apple TV and an
Android TV, and it's remembered per project; **Auto** takes the first booted
device of the right kind.

The rail is a stream and nothing else: no device picker, no boot or install, no
taps. It doesn't need them, because the run names its device. When a run starts
without one selected, `runFlow` resolves the first free booted device itself
rather than letting the runner pick silently, reserves it under that id, and
returns it — so Studio attaches to the same screen the test is driving instead
of showing "no device" while maestro works away on a simulator.

**Running by hand.** The run wizard walks a filtered selection case by case:
preconditions, each step with its expected result, pass/fail/skip per step,
a note and the app version under test, then a result — passed, failed, blocked,
skipped or invalid, Qase's own set — and on to the next case. A case with a flow
can hand off to it mid-session.

**From the agent.** Studio's MCP server is how an agent reads and updates cases:
`list_test_cases`, `describe_test_case`, `get_cases_datasource`,
`sync_test_cases`, `scaffold_case_flow`, `link_case_flow` and
`record_case_result`. In Qase mode the tools tell the agent that case content is
authored in Qase — it links flows and assigns page objects, and never rewrites a
title or a step.

**Test plans** are the named selections a team actually runs — "release smoke",
"everything high-priority on tv". They're YAML in the same store, built from whatever the matrix is currently filtered to, and a plan run walks
its cases in order on one device, recording each outcome against its case. Cases
with no flow are reported as skipped rather than quietly dropped.

**Coverage** is checked both ways: a case pointing at a missing flow is an
error, and a flow no case traces back to is a warning — coverage the matrix
can't see.

Results are local: what ran on your machine, what you recorded by hand, what the
agent verified. They carry Qase's result shape — `case_id`, `status`, `time_ms`,
`comment`, per-step statuses — so pushing them back to a Qase test run is a small
addition rather than a remap. Studio is a local test-engineering tool; nothing
here runs in CI, and a run's outcome comes from the execution log and nowhere
else.

---

## Development

```bash
pnpm install
pnpm dev:studio          # Vite + Electron          (from the repo root)
pnpm build:studio        # type-check + build renderer + bundle electron
pnpm storybook           # the design system at :6006
```

| Command (in `apps/studio`) | What it does |
| --- | --- |
| `pnpm dev` | Vite dev server + Electron |
| `pnpm build` | Type-check (renderer + electron) + Vite build + esbuild bundle |
| `pnpm typecheck:app` / `typecheck:electron` | The two tsconfigs on their own |
| `pnpm dist` | Unsigned local `.app` (electron-builder.yml) |
| `pnpm dist:release` | Signed + notarized, published to GitHub Releases |

Environment: `STUDIO_PROJECT_ROOT` (which repo to open), `CONDUCTOR_LOCAL`
(build the bundled CLI from a local checkout), `STUDIO_PORT` (dev server port).

### Layout

```
apps/studio/
  electron/            main process, preload, IPC, services
    services/          file, conductor, device, flow, maestro, cases, pom,
                       scenegraph, agent, updater, settings
  app/                 React renderer
    lib/               ipc, events, types, router, completion, flow slicing
    hooks/             useIpcEvent, useDeviceStream (WebCodecs)
    stores/            data-only Zustand stores
    components/        layout, flows (workbench), agent, cases
  build-electron.mjs   esbuild bundle for main/preload
  vite.config.ts       renderer (COOP/COEP for WebCodecs)
```

### Architecture

- **IPC is four layers**: a service in `electron/services/<domain>/`, registered
  in `electron/ipc.ts` via `handle('snake_case', …)`, called through a typed
  wrapper in `app/lib/ipc.ts` (the only caller of `window.conductorStudio`), with
  shared types in `app/lib/types.ts` — which `tsconfig.main.json` includes, so
  the backend imports the same file.
- **Push events** go the other way: `broadcastToRenderers(channel, payload)` →
  `listen()` / `useIpcEvent()`. Channels are suffixed per entity, e.g.
  `device_video_frame:{deviceId}`, `flow_run_steps:{runId}`, `agent:event:{id}`.
- **State** is data-only Zustand stores in `app/stores/` with module-level
  mutators, so services can drive them imperatively. `electron/state.ts` is the
  backend's single in-memory state.
- **Routing** is hash-based URL-as-state in `app/lib/router.tsx` (`#/flows`,
  `#/flows/<path>`, `#/agent`, `#/cases`). No store mirrors "which screen".
- **Build**: esbuild bundles `electron/{main,preload}.ts` to CJS in
  `dist-electron/`; Vite builds the renderer. Three tsconfigs (renderer, main,
  node).
- **Design system**: token-only styling (`packages/studio-ui/src/styles/tokens.css`,
  light `:root` plus dark `:root[data-theme="dark"]`), one component per folder
  with `.tsx` + `.module.css` + `.stories.tsx`, a single `Icon` component (no
  inline SVG in the app), and a story for every component.

### Video decoding

The daemon sends **bare IDR access units** — the SPS/PPS live only in the config
frame — so the renderer configures its `VideoDecoder` with the `avcC`
`description` and the main process rewrites each Annex B access unit to AVCC
(4-byte length-prefixed NALs) before forwarding it. This mirrors Argus's device
streams. Frames that arrive as a plain object from structured clone are rebuilt,
deltas are dropped while the decoder is behind or awaiting a keyframe, and a
decode error resyncs on the next keyframe rather than surfacing.

## Bundled conductor CLI

Studio ships its own conductor CLI rather than reaching for whatever is on
`PATH` — a global install of an unrelated version is exactly the failure this
avoids, and a Finder-launched `.app` can't see the user's shell `PATH` anyway.

`scripts/prepare-conductor.ts` installs a pinned published version into
`native/conductor/` with `npm install --prefix`, producing a flat, self-contained
tree (`.version` marker, `bin/conductor` shim, `node_modules/`). It runs on
`postinstall` and ahead of every `dist*` script. `scripts/electron-after-pack.cjs`
then copies that tree into the packaged app's `Resources/` — a hook rather than
`extraResources`, because electron-builder's matcher strips nested
`node_modules` even when a filter asks for them.

**The driver binaries are never bundled.** The npm package ships only `dist/`,
`proto/` and `skills/`; the CLI downloads `drivers.tar.gz` from its own release
tag on first use into `~/.conductor/drivers/<version>/`. So the tree Studio
ships is ~32 MB of pure JavaScript with no Mach-O binaries in it — which is what
keeps `Resources/` notarizable, since anything executable in there would need
signing of its own.

**A published version, not the workspace build.** That lazy download is keyed to
the CLI's own version, and a workspace build carries an unreleased version whose
tag doesn't exist yet — its drivers would 404.

To develop against unpublished CLI changes, point `CONDUCTOR_LOCAL` at a
checkout. The script installs from there and drops the version marker so the
next run always picks up rebuilds. Build the drivers first: `npm install <dir>`
packs the source per its `files` field, so `drivers/` isn't copied, and the
script symlinks the locally built ones into the package root — where the CLI
looks before it tries the network.

```bash
make build                                            # at the repo root, populates packages/cli/drivers/
CONDUCTOR_LOCAL=../../packages/cli pnpm prepare-conductor
```

A local-mode tree points outside the app and must not be packaged for release;
`dist:release` installs from the registry.

### Version override

Settings → **Conductor version** pins any published version at or above the
bundled one. `electron/services/conductor/override.ts` installs it into
`<userData>/conductor/<version>/` on demand and `paths.ts` prefers it, so no app
update is needed. The pin lives in `<userData>/conductor.json` — its own file, so
a corrupt settings blob can't strand the app on an uninstallable version.

Provisioning needs `npm` on `PATH` (Electron's Node ships none) and registry
access; a failure falls back to the bundled tree and surfaces in the picker.
The shim source and npm args live in `electron/services/conductor/install.ts`,
imported by both the build script and the runtime provisioner so they can't
drift.

Studio spawns the CLI's entry point directly under Electron-as-Node. The
`bin/conductor` shim is what the **agent** gets, since it runs conductor from a
Bash tool where an `electron --run-as-node <entry>` invocation wouldn't survive.

## Packaging

- `electron-builder.yml` — unsigned local `dir` build.
- `electron-builder.release.cjs` — signed + notarized dmg/zip, published to
  GitHub Releases. Notarization is electron-builder-native (App Store Connect
  API key env vars); signing certs come from the keychain (e.g. Fastlane match).
- `.github/workflows/studio-release.yml` runs the release on demand.

### Releasing

Studio shares the conductor repo with the CLI, so its releases are tagged
`studio-v<version>` (`tagNamePrefix`) to keep them off the CLI's `v<version>`
tags. The version is the only input, and **changesets owns it** — a Studio
changeset bumps `apps/studio/package.json` during the CLI release workflow's
`changeset version` step, which also writes `apps/studio/CHANGELOG.md` for the
release body. So cut a CLI release first, then run this one. Hand-edit the
version only to move to a prerelease. A prerelease version publishes to that
channel and is marked a GitHub prerelease; a plain one publishes to stable:

| Version | Tag | Channel | GitHub |
| --- | --- | --- | --- |
| `0.2.0` | `studio-v0.2.0` | `latest` | release |
| `0.2.0-beta.1` | `studio-v0.2.0-beta.1` | `beta` | prerelease |

Artifacts are named `conductor-studio-<version>-<arch>.<ext>` rather than using
`${productName}` — GitHub rewrites spaces in uploaded asset filenames, which
would break the download URLs recorded in the channel yml.

### Updates

electron-updater runs on the **`generic`** provider against
`https://houwert.dev/conductor/studio/updates`, not the `github` one. The github
provider resolves the stable channel through a repo-wide `/releases/latest`,
which in this repo returns a conductor CLI release that carries no channel yml.

That URL is a Cloudflare Pages Function in the houwert.dev repo
(`functions/conductor/studio/updates/[[path]].ts`), forked from the Argus
updates proxy. It filters releases to the `studio-v` prefix, resolves
`<channel>-mac.yml` to the newest release in that channel's tier (`alpha` ⊇
`beta` ⊇ stable, so beta testers still get a stable cut that outpaces the last
beta), and streams the asset back. Adding a route there also requires listing it
in that repo's `public/_routes.json`.
