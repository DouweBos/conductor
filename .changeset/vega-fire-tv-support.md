---
'@houwert/conductor': minor
---

Add Vega (Amazon Fire TV) as a fifth platform, alongside iOS, Android, tvOS, and
web. Vega is a React Native (Hermes) OS driven host-side through Amazon's
`vega`/`kepler` CLI plus the on-device automation toolkit — there is no driver
process or control port. `conductor start-device --platform vega` boots a Vega
Virtual Device (VVD) via `vega virtual-device start` (or attaches to a running
one; `--name <vvd>` selects a specific device); devices appear in `list-devices`
as `vega:<serial>`.

D-pad remote navigation works via `press-key "Remote Dpad …"`, and coordinate
`tap-on`/`swipe`/`scroll` work via the stock `inputd-cli`. `inspect`/`capture-ui`
reuse the Android element resolver — the toolkit page source is re-emitted as
uiautomator XML. `screenshot`, `input-text`, and app launch/stop/install are
supported. Device + Metro logs are collected by a logs-only daemon (React Native
Metro/profiler attach over Hermes). Deep links, `set-location`, gestures, screen
recording, clipboard, and `clear-state`/`uninstall-app` are unsupported and fail
with a clear message.

The Vega SDK CLI must be installed and on `PATH` (or set `CONDUCTOR_VEGA_CLI`);
the VVD's developer mode must be enabled for input, and apps under test should be
launched via conductor so the automation toolkit attaches.
