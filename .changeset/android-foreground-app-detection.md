---
"@houwert/conductor": patch
---

Fix Android foreground-app detection on API 29+. The `dumpsys activity activities` regex only matched the legacy `mResumedActivity:` label; modern Android prints `ResumedActivity:` / `topResumedActivity=`, causing `conductor foreground-app` to fail with "Could not determine foreground app" and `conductor memory` (without an explicit app id) to silently fall back to system-only output. The regex now matches all three forms. As a side fix, `conductor memory` no longer requires the gRPC driver daemon to be running just to resolve the foreground app — it queries adb directly — and emits a clear note when no app can be resolved.
