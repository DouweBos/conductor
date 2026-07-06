---
"@houwert/conductor": minor
---

Add `web-targets` and `--cdp-url` / `--cdp-target` for driving an existing
browser over CDP.

- `web-targets --cdp-url <url>` lists the controllable page targets a browser
  exposes over its remote-debugging endpoint (e.g. one per Electron
  `WebContentsView`), each with a ready-to-paste bind command. Reads the
  DevTools `/json/list` endpoint directly — no Playwright needed, works before
  any session exists.
- `--cdp-url` / `--cdp-target` set the CDP attachment for a web session and
  persist it to the session, so after binding a `--device` to a target once,
  later commands for that device no longer need the flags. Use a distinct
  fully-qualified `--device web:<browser>:<label>` per target to drive several
  concurrently.
