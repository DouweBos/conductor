---
name: conductor-parity
description: Prove that a rebuilt screen still matches the original by walking the same journey through two builds of an app and diffing the captured checkpoints semantically — missing elements, changed text, layout drift and reading order — with the conductor CLI. Use when porting or rewriting a screen (React Native → Swift/Kotlin, a redesign, a framework upgrade), verifying an old build against a new one, gating a migration checkpoint on visual parity, or comparing the same app across two devices or platforms.
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
| `--ignore <kinds>` | Drop these finding kinds entirely |
| `--blocking <kinds>` | Which kinds fail a checkpoint (default `missing,text,value,checkpoint-missing,geometry`) |
| `--strict` | Every kind blocks — including layout drift |
| `--env K=V` | Inject an env var into the flow (repeatable) |

## Reading the findings

Each finding is **blocking** (fails the checkpoint) or **advisory** (reported,
does not fail).

| Kind | Means | Default |
|---|---|---|
| `missing` | In the reference, absent from the candidate — **a dropped element** | blocking |
| `text` | Matched element, different label | blocking |
| `value` | Matched element, different value | blocking |
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

Work the blocking findings first — they are sorted to the top of both reports.

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
