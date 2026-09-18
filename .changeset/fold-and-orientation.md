---
'@houwert/conductor': minor
---

Add fold control for foldable simulators and orientation read/write

`set-fold <closed|book|open|0-180>` folds, half-opens or unfolds an iPhone Duo,
or parks the hinge at an exact angle; `get-fold` reports the current angle and
pose. Apple ships no fold setter, so this injects a small controller into the
simulator's locationd and feeds CoreMotion's device-state relay the same input
Device Hub's hinge slider produces — see `packages/ios-fold` for why the other
routes are closed. Build the controller with
`packages/ios-fold/tools/build-fold.sh`.

Foldables also ignore `devicectl device orientation set`, so `set-orientation`
verifies the result and rotates them through the same injected controller.

`get-orientation` is new, and `set-orientation` now accepts
`portraitUpsideDown`, `landscapeLeft`, `landscapeRight`, `faceUp` and `faceDown`
alongside `portrait`/`landscape`. On iOS both go through devicectl, so neither
needs the test driver running.
