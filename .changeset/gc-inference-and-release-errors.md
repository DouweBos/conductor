---
"@houwert/conductor": patch
---

Three corrections from a release-build run on a Fire TV Stick 4K Max.

**`profile memory --track` asserted the opposite of the truth about GC.** When
logcat produced no ART collections it said a quiet window was "a real signal".
On Fire OS (API 30) it is not: a 30s window logged no collections while the Java
heap fell 11.8MB and `systemBytes` fell 21.1MB. Memory that size is not
reclaimed without collections running, so collections happened and none were
logged — the instrument was blind, not the window quiet.

The command now infers collections from the heap series itself and reports
`inferredGc`: a heap that shrinks between two samples was collected between
them, and there is no other mechanism. Drops under 256KB are treated as
sampling jitter. When logcat is silent but the deltas are not, the output says
so and names ART's logging as the thing at fault. Treat logcat as best-effort
and the deltas as the primary signal.

**"no debugger targets" pointed at the wrong cause.** The error asked "Is an app
running on a device/simulator?" — which sends you to check something already
true. The usual cause is a release build: release Hermes ships without the
inspector and never connects to Metro, so no amount of relaunching helps. Both
the CDP and log-streaming paths now lead with that, and note the consequence
that anything attaching over Metro needs a debug or profiling build.

Documented alongside it: the Hermes GC share is therefore **not measurable on a
release build**, so it cannot be compared across build types — only
`profile frames` and `profile memory` can. Android also runs two collectors that
can disagree, and on this app they did: Hermes GC was ~30% of JS samples in the
same window ART stayed quiet enough never to log.
