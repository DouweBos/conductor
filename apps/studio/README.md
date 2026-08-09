# Conductor Studio

Desktop app for writing & managing Maestro tests, agentic test writing, and test
case management — built on the conductor CLI.

See [`docs/studio.md`](../../docs/studio.md) for the full overview.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Vite dev server + Electron |
| `pnpm build` | Type-check (renderer + electron) + Vite build + esbuild bundle |
| `pnpm dist` | Unsigned local `.app` (electron-builder.yml) |
| `pnpm dist:release` | Signed + notarized, published to GitHub Releases |

## Layout

```
apps/studio/
  electron/            main process, preload, IPC, services
    services/          file, conductor, device, flow, maestro, cases, pom,
                       scenegraph, agent, updater, settings
  app/                 React renderer
    lib/               ipc, events, types, router
    hooks/             useIpcEvent, useDeviceStream (WebCodecs)
    stores/            data-only Zustand stores
    components/        layout, flows (workbench), agent, cases
  build-electron.mjs   esbuild bundle for main/preload
  vite.config.ts       renderer (COOP/COEP for WebCodecs)
```
