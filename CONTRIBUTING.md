# Contributing

Issues and pull requests are welcome. For larger changes, open an issue first to discuss the approach.

## Setup

See [Building locally](README.md#building-locally) for prerequisites. Then:

```bash
pnpm install
make build
pnpm test
```

## Pull requests

- Add a changeset (`pnpm changeset`) for anything user-facing; releases are cut from these.
- When you add or change a command or flag, update the matching skill in `packages/cli/skills/` in the same PR.
- Run `pnpm lint` before pushing.
