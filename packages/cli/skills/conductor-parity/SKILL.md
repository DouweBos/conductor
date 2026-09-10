---
name: conductor-parity
description: Prove that a rebuilt screen still matches the original by walking the same journey through two builds of an app and diffing the captured checkpoints semantically — missing elements, changed text, focus, layout drift and reading order — with the conductor CLI. Use when porting or rewriting a screen (React Native → Swift/Kotlin, tvOS ↔ a Lightning/canvas TV app, a redesign, a framework upgrade), verifying an old build against a new one, gating a migration checkpoint on visual parity, or comparing one app across two platforms.
---

# Conductor — parity between two builds

When a screen is rebuilt, the question is not "does it work" but "is it still the
same screen". `conductor parity` answers that by walking one journey through
**two builds**, capturing named checkpoints in each, and diffing them.

Use it as a **gate**: a rebuild is not done until parity passes. The command
exits non-zero when a checkpoint has blocking findings, so it drops straight
into a build script or a pre-commit check.

## Why not just compare screenshots

Two builds of the same screen in different stacks never agree pixel-for-pixel —
font rasterisation, shadows, ripple colours and sub-pixel rounding all differ
while the screen is, to a user, identical. Tighten a pixel threshold and every
checkpoint fails; loosen it and a missing button passes.

So parity compares the **accessibility snapshot** first: which elements exist,
what they say, what role they play, where they sit, in what reading order. The
pixel ratio is reported alongside as corroborating evidence, not as the verdict.
Use `assert-screenshot` (in `conductor-inspect`) when you *do* want a strict
pixel baseline of a single screen against itself.

## The loop

1. **Mark the journey.** Add `- checkpoint: <name>` steps to a flow at each point
   worth comparing. Outside a parity run these are no-ops, so the flow still
   runs normally under `run-flow`.
2. **Record the reference** against the build you are porting *from*.
3. **Rebuild** the screen.
4. **Compare** against the build you are porting *to*. Fix what it reports.
5. Repeat 3–4 until it passes, then commit and move to the next screen.

```yaml
# cart.yaml — one journey, shared by both builds
appId: com.example.myapp
---
- launchApp
- checkpoint: cart-empty
- tapOn: "Sneakers"
- tapOn: "Add to cart"
- checkpoint: cart-one-item
- tapOn: "Checkout"
- checkpoint: checkout
```

```bash
# 2. Reference — the old build, on the device running it
conductor parity record cart.yaml --out .parity/cart/reference \
  --device <old-build-device> --label "react-native"

# 4. Candidate — the rebuilt app; diffs and gates in one step
conductor parity compare cart.yaml --reference .parity/cart/reference \
  --out .parity/cart/native --device <new-build-device> \
  --html .parity/cart/report.html
```

Commit the reference run to the repo. It is the contract the rebuild has to
meet, and it stops being reproducible once the old build is gone.

## Commands

| Command | Purpose |
|---|---|
| `conductor parity record <flow> --out <dir>` | Walk the flow, capture every checkpoint as a **reference** run |
| `conductor parity compare <flow> --reference <dir>` | Walk it against the candidate build, then diff and gate |
| `conductor parity diff <ref-dir> <cand-dir>` | Diff two runs already on disk — no device, no app, instant |
| `conductor parity matrix <ref-dir> <dir...>` | Diff one reference against **many** recorded runs, as a grid |
| `conductor parity snap <name> --out <dir>` | Compare what every device is showing **right now** — no flow |
| `conductor checkpoint <name> --run <dir>` | Capture one checkpoint ad hoc, for journeys driven command-by-command |

`parity diff` is the one to reach for while tuning thresholds: re-diffing costs
nothing, so tune against a recorded pair rather than re-driving the app.

### Flags

| Flag | Effect |
|---|---|
| `--out <dir>` | Where to write the run (`compare` defaults next to the reference) |
| `--label <text>` | Name the run in the report |
| `--json-report <path>` | JSON report path (default `<candidate-run>/parity.json`) |
| `--html <path>` | Self-contained side-by-side HTML report — for a human to sign off |
| `--frame-tolerance <pt>` | Drift allowed before `moved` / `resized` (default 8) |
| `--pixel-threshold <0-1>` | Pixel difference allowed before a `pixel` finding (default 0.1) |
| `--min-overlap <0-1>` | Frame overlap needed to pair elements by position (default 0.5) |
| `--ignore-case` | Compare labels case-insensitively |
| `--ignore-role` | Pair elements without requiring roles to agree (automatic across platforms) |
| `--ignore <kinds>` | Drop these finding kinds entirely |
| `--blocking <kinds>` | Which kinds fail a checkpoint (default `missing,text,value,focus,checkpoint-missing,geometry`) |
| `--strict` | Every kind blocks — including layout drift |
| `--target <label>=<device>` | Walk this device as a named target (repeatable) — turns `compare` into a parallel N-target run |
| `--env K=V` | Inject an env var into the flow (repeatable) |

## Reading the findings

Each finding is **blocking** (fails the checkpoint) or **advisory** (reported,
does not fail).

| Kind | Means | Default |
|---|---|---|
| `missing` | In the reference, absent from the candidate — **a dropped element** | blocking |
| `text` | Matched element, different label | blocking |
| `value` | Matched element, different value | blocking |
| `focus` | Focused in one build but not the other — **the wrong thing is selected** | blocking |
| `checkpoint-missing` | The candidate never reached this checkpoint — the journey diverged | blocking |
| `geometry` | The two screens are not comparable; position findings suppressed | blocking |
| `added` | In the candidate only | advisory |
| `moved` / `resized` | Matched element, shifted or resized past tolerance | advisory |
| `reordered` | Matched element, different reading-order position — **an accessibility regression** | advisory |
| `state` | Different enabled/selected/checked state | advisory |
| `pixel` | Screenshot differs past the threshold | advisory |

`missing` is the finding that matters most: it is how a rebuild silently loses a
button. A **changed label** is reported as `text` on the matched element, not as
a `missing` + `added` pair, so don't read those two as unrelated.

`focus` blocks because on a remote-driven TV app focus *is* the interaction
model — a screen that comes up with the wrong tile selected is not at parity. It
produces nothing when neither build reports focus, so it costs nothing on
platforms where focus isn't meaningful; `--ignore focus` switches it off.

Every finding about a specific element carries its `identifier` when it has one,
so you have the handle to fix it by.

Work the blocking findings first — they are sorted to the top of both reports.

## Across two stacks (tvOS ↔ Lightning, native ↔ web)

Parity works between *different platforms*, not just two builds of one. That is
what covers tvOS against a canvas TV app (Lightning/WPE/RDK, e.g. an app built
with `@plexinc/react-lightning`), or a native app against its web build.

Two things make it work, and one thing you have to do:

- **Roles are relaxed automatically** when the platforms differ. Role
  vocabularies don't line up across stacks — a control is `button` on tvOS and
  `generic` in a canvas app, where the scene graph is mirrored into off-screen
  divs with no ARIA role. The report tags such checkpoints `roles relaxed`.
- **Frames line up** if you drive both at the same resolution, and screens at
  the same aspect ratio are rescaled automatically — 1280×720 against 1920×1080
  compares fine. Use `set-viewport 1920 1080` on the web side.
- **Tag your elements the same on both sides.** This is the one that's on you.
  Parity pairs on test identity first — `accessibilityIdentifier` on tvOS,
  `data-testid` on web — because identity is the only signal that survives a
  port. Give the same control the same id in both builds and matching is exact,
  labels can be reworded without confusing the diff, and findings name the id to
  fix them by. Without ids it falls back to label and position, which works but
  is much weaker across stacks.

```bash
conductor parity record cart.yaml --out .parity/ref --device <tvos-sim>
conductor set-viewport 1920 1080 --device web
conductor parity compare cart.yaml --reference .parity/ref --device web
```

On a TV app, drive focus with `press-key 'Remote Dpad Down'` and put a
checkpoint after each move: the `focus` finding then verifies that the D-pad
walks the two builds in the same order, which is the thing most likely to
diverge in a port and the hardest to eyeball.

## No flow: compare what is on screen right now

A flow is the wrong tool when the reference is *already* on the screen you care
about. Writing one to get back there answers no question. `parity snap` captures
the current screen on the reference and on every target, diffs them, and appends
to the same session — so calling it as you move through the app builds the grid
one screen at a time:

```bash
S=.parity/live
conductor parity snap home   --out $S --device <ref> --target "tvOS=<udid>" --target "VegaOS=<vvd>"
# ...navigate all the devices to the next screen...
conductor parity snap detail --out $S --device <ref> --target "tvOS=<udid>" --target "VegaOS=<vvd>"
```

The reference is whatever `--device` resolves to; targets are `--target`. A name
already used in the session is numbered (`home` → `home-2`) **for every device
at once**, so the screens still pair up.

Getting the targets onto the matching screen is yours to arrange — by hand, with
an agent, or with mirrored input in Studio. That is the honest division of
labour: `snap` compares what it is given, and none of those ways needs a flow.

Reach for `snap` first when someone asks whether a screen matches. Use the flow
path when the journey is worth scripting, or when the check has to be repeatable
in CI.

## One reference, many targets

A port rarely goes to one place: the same screen gets rebuilt for tvOS, Android
TV, VegaOS and a Lightning web build. Give `compare` a `--target` per build and
it walks them **in parallel**, then reports one grid:

```bash
conductor parity compare home.yaml --reference .parity/home/reference \
  --target "tvOS=<udid>" \
  --target "Android TV=emulator-5554" \
  --target "VegaOS=<vvd>" \
  --target "Lightning=web" \
  --out .parity/home/targets --html .parity/home/matrix.html
```

```
  checkpoint  tvOS    Android TV  VegaOS  Lightning
  ──────────  ──────  ──────────  ──────  ─────────
  home        ✓       ✗ 3!        ✗ 2!    ✓
  detail      ✓       ✓           ✗ 1!    ✓
```

Each target runs in its own process, so they genuinely run at once rather than
one after another. `parity matrix <ref-dir> <dir...>` does the same comparison
over runs already on disk, with no devices attached — the fast way to re-tune
thresholds across the whole set.

### Read the universal findings first

This is the thing a matrix tells you that four separate two-way runs cannot:

- a finding on **one** target is that target's bug;
- a finding on **every** target is a statement about the **reference**.

Four independent rebuilds rarely drop the same button. When they all report it,
the likelier explanation is that the reference run is stale, sat behind a
feature flag, or landed in a different experiment bucket. Both reports separate
these out under "Reported by every target" — start there, because one fix to the
reference can clear a finding from every column at once.

## Choosing checkpoints

- One per **meaningful state**, not per tap: empty, populated, error, loading
  settled. Checkpoints pair up by name across runs, so keep names stable.
- Capture **after** the screen settles. A checkpoint taken mid-animation records
  the animation, and reports drift that isn't real.
- Both runs need the **same screen size** for layout findings to mean anything.
  Different sizes at the same aspect ratio are rescaled automatically (the report
  says so); a different aspect ratio reports `geometry` and suppresses position
  findings.

## Tuning, honestly

Loosen a threshold only when you have confirmed the difference is a rendering
artefact and not a real regression. Reach for the narrowest tool that works:

1. `--frame-tolerance` for consistent spacing differences between stacks.
2. `--ignore reordered,state` when a platform genuinely exposes a11y differently.
   `--ignore-role` forces role relaxation on within one platform, too.
3. `--ignore missing` — almost never. It switches off the check that catches
   dropped elements, which is the main thing parity is for.

Going the other way, `--strict` makes layout drift blocking too — worth it for a
pixel-faithful port.

## Two devices at once

`record` and `compare` each drive one device, so run both builds side by side
and address them with `--device`:

```bash
conductor list-devices                     # find both ids
conductor parity record cart.yaml  --out .parity/ref  --device <A>
conductor parity compare cart.yaml --reference .parity/ref --device <B>
```

See `conductor-device-setup` for booting devices and installing builds, and
`conductor-create-flow` for authoring the flow itself.

## Tips

- `--json` emits the whole report as JSON — the fastest thing to parse and act on.
- The JSON report is always written next to the candidate run, so a failing gate
  leaves a machine-readable record behind with no extra flag.
- Diff images are written only for checkpoints that exceed the pixel threshold.
- A run interrupted mid-journey still leaves everything captured so far on disk.
- `conductor parity --help` for the exact flags.
