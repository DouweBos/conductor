# Plan: webtv (canvas) app support in conductor's web driver

Status: implemented (v0.20). Ported in spirit from the Bravo (Kotlin Maestro fork) web
commits, adapted to conductor's ARIA-snapshot architecture. Validated live against a
Lightning app at `localhost:3333`: `inspect` surfaces `data-testid`, `focused` reflects
`data-focused`, `assert-visible --id`/`tap-on --id` match the test hook, and
`press-key 'Remote Dpad …'` drives focus.

## Background

Conductor's web driver builds its `WebElement` hierarchy **exclusively** from Playwright's
`body.ariaSnapshot({ mode: 'ai' })` (`packages/cli/src/daemon/web-server.ts`,
`/viewHierarchy`). Bravo instead injects a `maestro-web.js` DOM walker. The five Bravo web
commits all modify that walker, so they do not port 1:1 — we port their *intent* onto our
ARIA path by adding a DOM-mirror harvesting pass.

### Why ARIA-only fails for webtv

Canvas-rendered TV frameworks (Lightning / WPE / RDK) draw the whole UI into one `<canvas>`
and expose the scene graph through a **DOM-inspector mirror** of off-screen `<div>`s. These
divs carry the real identity in `data-testid` and the focus state in `data-focused="true"`,
because the canvas owns real DOM focus.

### Evidence — live probe of the Lightning app on `localhost:3333` (sign-in/welcome)

```
totalEls: 48,  canvasCount: 1
distinctAttrs: ["id","tabindex","data-src","data-testid","data-focused"]
testidCount: 3,  dataFocusedCount: 1,  dataFocusedTrue: 1
activeElement: "BODY"               <-- focus is NOT on the focused node
samples:
  DIV testid="screen-welcome"      id="43" focused=null  text="No risk, all reward..."
  DIV testid="sign-in-button"      id="32" focused="true" text="Sign In"
  DIV testid="skip-sign-up-button" id="36" focused=null  text="Skip Sign Up"
```

Consequences in conductor today:
- `tap-on --id sign-in-button` / `assert-visible --id ...` cannot match — `id:` is matched
  against the ARIA `ref` (`e6`, `e7`), and the numeric DOM `id` is meaningless anyway.
- `--focused` / `focused: true` never matches the truly-focused node: `activeElement` is
  `BODY`, so `stampFocusFromDocumentActiveElement` finds nothing and `[active]` is absent.
- `press-key 'Remote Dpad Up'` is a silent no-op on web (no D-pad → arrow mapping), so the
  D-pad focus-navigation model — the only way to drive a TV app — is unavailable.

## Bravo commit → conductor change map

| Bravo commit | Intent | Conductor change |
|---|---|---|
| `4fd3d5f2` prefer `data-testid` for resource-id | `id:` targets the test hook | Harvest `data-testid` into `WebElement.testId`; match `sel.id`/`sel.query` against it |
| `1991402b` expose focus via `data-focused` | `focused:` works on canvas | Harvest `data-focused="true"` → `WebElement.focused` |
| `82c86799` REMOTE_* → arrow keys | D-pad navigates webtv | Add Remote Dpad → Arrow/Enter entries to web `WEB_KEY_MAP` |
| `184c6408` URL-shaped appId ⇒ web | `appId: https://…` implies web | Treat http(s) appId as a web flow (low priority; see §5) |
| `fbb62c80` honor `-p web` | force web device | Already handled — `pickDevice('web')` filters by platform |

## Implementation

### 1. Harvest the DOM-testid mirror  (core; `web-server.ts`)

Add a single `page.evaluate` pass that collects every element carrying `data-testid` (and/or
`data-focused`), returning for each: `testid`, `focused` (`data-focused === 'true'`), the
trimmed `textContent`, an `aria`-ish role if present, and `getBoundingClientRect`. Build these
into `WebElement` nodes and **merge** them into the tree produced from the ARIA snapshot.

Design decisions:
- **New field** `testId?: string` on `WebElement` (do not overload `ref`, which means the
  ARIA `[ref=eN]` used for `aria-ref=` bounds resolution).
- **Synthetic ref/nodeId** for mirror-only nodes so existing focus/bounds plumbing and the
  `@eN` snapshot-store path keep working. Use a distinct prefix (e.g. `t<testid>` or a running
  index) so it can't collide with Playwright's `eN`.
- **Merge, don't replace**: keep ARIA nodes (normal accessible web still works); add mirror
  nodes the ARIA snapshot lacked. De-dupe by bounds overlap + name so a node that appears in
  both sources isn't doubled (a mirror node should *enrich* the matching ARIA node with
  `testId`/`focused` when they overlap, else be appended).
- Bounds come straight from `getBoundingClientRect` in the same evaluate — no extra round
  trips, and it sidesteps the fact that mirror divs are off-screen/zero-painted but still
  rect-measurable.

Wire it into `/viewHierarchy` after `parseAriaSnapshot` and the bounds passes, before
`jsonResponse`. Gate cheaply: if `document.querySelector('[data-testid],[data-focused]')` is
null the pass is a no-op, so normal web pays ~nothing.

### 2. Match `id:` against `testId`  (`element-resolver.ts`)

In `matchesWebElement` (and the `sel.query` branch), match `sel.id` against `node.testId`
first, then fall back to `node.ref` (preserves current behavior for ARIA refs). Mirror the
`substringAfterLastSlash` semantics already used for ids. Update the web debug/serialization
lines (`visitWeb`, the chosen-element log) to print `testId` when present.

### 3. Focus from `data-focused`  (`web-server.ts`)

The harvest pass sets `focused` on mirror nodes from `data-focused="true"`. Order of focus
resolution in `/viewHierarchy` becomes: ARIA `[active]` → `data-focused` mirror →
`document.activeElement` (existing fallback). Because the canvas owns `activeElement`, the
`data-focused` source must take precedence over the activeElement fallback for webtv (the
fallback should only fire when no node is already focused — `treeHasFocused` already guards
this). `focused`-state matching in `element-resolver.ts` already reads `node.focused`, so no
change there. This makes `--focused`, `focused: true`, and `conductor focused` work on canvas.

### 4. Remote D-pad keys on web  (`commands/press-key.ts`)

Extend the web `WEB_KEY_MAP`:

```
'Remote Dpad Up'    -> 'ArrowUp'
'Remote Dpad Down'  -> 'ArrowDown'
'Remote Dpad Left'  -> 'ArrowLeft'
'Remote Dpad Right' -> 'ArrowRight'
'Remote Dpad Center'-> 'Enter'
```

(`web-server.ts` `/pressKey` already calls `page.keyboard.press(key)`, and Playwright accepts
these key names directly.) Mirrors Bravo `82c86799`. Lowest-risk, highest-leverage change —
without it nothing on a TV app can be driven.

### 5. URL-shaped appId ⇒ web  (optional; lower priority)

Conductor selects web by device/platform, not by flow content, so Bravo `184c6408` is less
load-bearing here. Optional nicety: when a flow's `appId` is `http(s)://…` and no explicit
`--device`/platform is given, prefer the web device. Defer unless it bites in practice.

## Validation (run against `localhost:3333`)

1. `start-device --platform web` → `launch-app http://localhost:3333`.
2. `inspect` shows mirror nodes with `testId` (`sign-in-button`, `skip-sign-up-button`,
   `screen-welcome`) and bounds.
3. `focused` reports `sign-in-button` (the `data-focused="true"` node).
4. `assert-visible --id sign-in-button` passes; `tap-on --id sign-in-button` taps its bounds.
5. `press-key 'Remote Dpad Down'` moves focus; `focused` reflects the new node.
6. Regression: a normal accessible web page (real ARIA roles, real DOM focus) still resolves
   text/id/focus exactly as before.

## Test coverage (`packages/cli/tests/`)

- Unit: `parseAriaSnapshot` + mirror-merge — feed an ARIA YAML plus a fake mirror node set,
  assert merged tree carries `testId`/`focused` and de-dupes overlaps.
- Unit: `matchesWebElement` matches `sel.id` against `testId` and still against `ref`.
- Unit: `press-key` maps Remote Dpad → Arrow on `WebDriver`.
- E2E (guarded, needs a webtv target): the validation steps above as a flow.

## Risks / open questions

- **Merge/de-dupe heuristic** is the only non-mechanical part — bounds-overlap + name match.
  Worst case we emit duplicate nodes; the `index`/deepest-match logic tolerates that, but it
  muddies `inspect`. Tune against the real app.
- **Mirror schema is framework-specific.** This app uses `data-testid` + `data-focused`.
  Other webtv stacks (Vega/React-Canvas, WPE) may differ; keep the harvested attribute names
  in one small config so they're easy to extend.
- **Off-screen mirror bounds.** The mirror divs may report layout rects that don't match the
  painted canvas position. If taps land wrong, we may need a coordinate mapping from mirror
  rect → canvas paint rect (the canvas/Lightning stage usually maps 1:1, but verify).
