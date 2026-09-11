---
'@houwert/conductor': minor
---

Add `conductor metro use` to point an app at a specific Metro

An app asks for the Metro port compiled into React-Core from `RCT_METRO_PORT` at
pod-install time, so a build can end up asking for a port nothing is serving — a
git worktree running its own Metro, or a pod install from a shell missing the env
var. `metro use <port|host:port> [<appId>]` overrides it through the
`RCT_jsLocation` preference, so no recompile is needed and the setting survives
reinstalls; `metro use --reset` drops it again. Relaunch the app to apply.

iOS/tvOS simulators only — Android has no equivalent preference, so map the port
with `adb reverse` instead.
