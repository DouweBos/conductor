# Privacy

Conductor is a pure command-line tool. It runs on your machine, talks to
your simulators / emulators / browsers, and does nothing else over the
network. This page is the full account of what it does and doesn't do.

---

## What Conductor sends to us

Nothing.

There is no telemetry, no analytics, no crash reporter, no usage
beacon, no signed-in account, and no API key. There is no service to
sign up for. There is no opt-in toggle to flip — because there is
nothing to opt into.

You can verify this yourself: the source is open at
[github.com/DouweBos/conductor](https://github.com/DouweBos/conductor).
Search the source for `posthog`, `sentry`, `amplitude`, `segment`,
`analytics`, or `telemetry` and you'll find no matches.

---

## What Conductor talks to over the network

Two outbound network calls exist, and you control both:

1. **The npm registry** — once every 24 hours, the CLI checks the npm
   registry for a newer version of `@houwert/conductor` and prints a
   one-line nag if there is one. The result is cached locally and the
   request times out quickly. If the network is offline the CLI just
   continues. No payload, no identifiers — only the npm registry sees
   the request.
2. **Whatever your driver hits.** When Playwright drives a browser,
   the browser talks to whatever site you point it at. When the iOS
   or Android driver runs your app, your app makes whatever network
   calls it normally would. Conductor itself is not in that path.

---

## What Conductor stores on your machine

Everything Conductor persists lives under `~/.conductor/`:

```
~/.conductor/
  sessions/<name>.json        ← per-session { appId, deviceId }
  update-check.json           ← npm latest-version cache
  daemon-<session>.sock       ← Unix socket for the optional daemon
  drivers/                    ← unpacked iOS / Android drivers (cached binaries)
```

It's plain text. Delete the directory at any time — Conductor will
recreate what it needs.

---

## What Conductor reads from your machine

- Whatever path you pass to it (e.g. `install-app /path/to/app.apk`,
  `run-flow tests/login.yaml`).
- `simctl` / `xcrun` for iOS device discovery.
- `adb` for Android device discovery and driver installation.
- The current working directory and `process.env` for flow-env
  expansion.

It doesn't crawl your filesystem, scan your repos, or read anything
you didn't point it at.

---

## License and source

[MIT licensed](https://github.com/DouweBos/conductor/blob/main/LICENSE).
Public source. No closed-source binaries beyond the standard
Playwright-managed browsers and the bundled XCTest / instrumentation
drivers — both of which are also open and shipped from this repo.

If you find something this page doesn't explain, please
[open an issue](https://github.com/DouweBos/conductor/issues) — the
goal is for the privacy story to be boring, complete, and easy to
verify.
