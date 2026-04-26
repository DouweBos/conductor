---
'@houwert/conductor': minor
---

Expand `conductor memory` into a real cross-platform memory debugger.

**New flags**

- `--objects` — per-class object counts and bytes. iOS uses `heap`, Android pulls a `.hprof` heap dump and parses it inline (full HPROF binary parser handling standard JVM and Android ART extensions, both 4- and 8-byte ids, per-heap segmentation), Web takes a real V8 `HeapProfiler` snapshot via CDP and parses the node table by constructor.
- `--leaks` — leak/unreachable detection. iOS uses `leaks`, Android uses `dumpsys meminfo --unreachable` (aggregated by user library frame so the actual leaking module surfaces above libc/libart). Both report total count + bytes broken down by class/owner.
- `--save <name>` / `--diff <name> [--vs <other>]` / `--snapshots` — snapshot save and diff workflow under `~/.conductor/memory-snapshots/`. Diffs surface per-class deltas (Δ count, Δ bytes) sorted by absolute change so the suspect class floats to the top.
- `--top <n>` — caps every table (default 20).
- `--no-gc` — skip the pre-measurement GC on Web (default-on for `--objects` so transient allocations don't pollute class counts).
- `--filter <regex>` — restrict object/class tables (and diff rows) to matching names; useful for cutting JVM/system noise.
- `--growth-only` — diff output only shows positive deltas, the leak-hunting view.

**iOS reporting**

- Reports `Footprint` (jetsam-relevant phys footprint) and `Dirty` totals from the host `footprint <pid>` tool, ahead of RSS — these are the numbers iOS actually uses to OOM-kill apps, while RSS overcounts shared text pages.

**Bug fixes**

- iOS `vm_stat` is now run on the host instead of inside the simulator (the binary doesn't ship inside the simulator runtime).
- iOS `vmmap` region parser was breaking on the `===` separator row and dropping every region; now correctly populates the region table.

**Dump artifacts**

`--objects` also writes the raw platform dump (`.hprof` for Android, `.heapsnapshot` for Web) to `~/.conductor/heap-dumps/` so it can be opened in Android Studio's Memory Profiler or Chrome DevTools for deeper analysis (retainer paths, dominator trees).
