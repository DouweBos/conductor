---
"@houwert/conductor": patch
---

Corrections from release-build runs on a Fire TV Stick 4K Max.

**The release-safe list was wrong twice over; it is now two commands.**
`profile cpu` does not work on a stock release build either: simpleperf refuses
a process that is neither `android:debuggable` nor
`<profileable android:shell="true"/>`, and a release APK is neither. The failure
was also opaque — `exited with 1` buried under a wall of `cannot read event
type` lines that are simpleperf probing PMU support, not the error. The command
now filters that chatter, inspects the package flags on failure, and names the
manifest change that would fix it. `profileable` is the one to reach for: a
single line that keeps the build a release build.

So the genuinely release-safe commands are `profile frames` and
`profile memory`. `profile cpu` needs a debuggable or profileable build;
`profile js` and `profile react` need a Metro-connected one.

**`profile cpu --report` now rolls up by library.** A flat profile with no hot
symbol is common, and when the app's own `.so` files are stripped the real
finding arrives as a dozen `libfoo.so[+1a62f8]` rows that read as a dozen
unrelated hotspots rather than one library dominating. Reports now lead with a
per-library rollup, carry `byDso` and `unsymbolisedPercent` in `--json`, and say
so when a meaningful share of samples resolved to raw addresses.

**The `single-window` note now carries the measured spread.** Five identical
release captures of one screen ranged 37.8-72.9% janky and 6.2-13.0ms
`issueDraw` p50, with a debug capture sitting inside both ranges. Frame timing on
TV varies enough between identical runs to invent a regression, so the note now
says to treat `--repeat 5` as the default posture rather than an option, and the
docs carry the run-by-run numbers.
