# Web testing

Conductor's web support lets the same commands you use on iOS and
Android drive a Playwright-managed browser instead. This means an AI
agent that already knows how to drive a phone can drive a web app
without learning a new vocabulary.

---

## Install the browser

Browsers aren't bundled — fetch the one you want with
`install-web`:

```bash
conductor install-web              # default: chromium
conductor install-web firefox
conductor install-web webkit
conductor install-web --check      # show install status only
```

Under the hood this calls
[`playwright-core`](https://playwright.dev) to download the browser
binary. Once installed, the browser is reused across all subsequent
commands; you don't need to reinstall per session.

---

## Targeting a browser

A "web device" is selected via `--device`:

| Device id        | Browser                                |
| ---------------- | -------------------------------------- |
| `web`            | Chromium (default).                    |
| `web:chromium`   | Chromium, explicit.                    |
| `web:firefox`    | Firefox.                               |
| `web:webkit`     | WebKit.                                |
| `web:firefox:foo`| Firefox in a sub-instance named `foo`. |

The third segment is an opaque sub-id Conductor uses to isolate
parallel browser instances. Useful when running flows in parallel —
each flow gets its own browser even if they all want Firefox.

```bash
conductor --device web open-link https://example.com
conductor --device web tap-on "Get started"
conductor --device web assert-visible "Welcome"
```

---

## What works the same as native

The mobile vocabulary translates directly:

- `tap-on`, `input-text`, `erase-text`, `press-key`, `back`,
  `hide-keyboard`, `scroll`, `scroll-until-visible`, `swipe` — all
  drive the page the same way they drive a screen.
- `assert-visible`, `assert-not-visible` — same matchers, same
  disambiguators.
- `inspect`, `focused`, `take-screenshot`, `capture-ui` — same
  output shapes, with the DOM standing in for the native hierarchy.
- `open-link <url>` — navigates to the URL.

---

## What's web-specific

- Element matching uses the DOM. Visible text and `aria-label` /
  `id` attributes are the primary handles. The `--id` flag matches
  the `id` attribute; the `--text` flag matches visible text.
- `set-location` translates to Playwright's geolocation override.
- `set-orientation` translates to viewport flips.
- The browser instance lives as long as the daemon (or the single
  command, if no daemon is running). Pages persist across commands
  in the same session.

---

## Running flows on the web

The same flow files you use on iOS and Android work on web:

```bash
conductor run-flow tests/login.yaml --device web
conductor run-parallel --flows-dir tests/ --devices web,web:firefox,web:webkit
```

Cross-platform flows can branch on `${DEVICE}` if you really need to,
but most flows can stay platform-agnostic.

---

## When to use it

- Smoke-testing a web app from inside an AI coding session — the
  agent edits, reloads, taps, asserts.
- Sanity checks against your local dev server before opening a PR.
- Running the same regression flows you wrote for mobile against the
  web build.

It's not a replacement for a full Playwright suite when you need the
expressivity of `page.evaluate(...)` or fine-grained network control —
but for the "drive my app like a user" loop, the mobile-shaped
commands are usually enough.
