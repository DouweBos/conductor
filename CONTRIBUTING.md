# Contributing

Issues and pull requests are welcome. For larger changes, open an issue first to discuss the approach.

## Setup

See [Building locally](#building-locally) for prerequisites. Then:

```bash
pnpm install
make build
pnpm test
```

## Pull requests

- Add a changeset (`pnpm changeset`) for anything user-facing; releases are cut from these.
- When you add or change a command or flag, update the matching skill in `packages/cli/skills/` in the same PR.
- Run `pnpm lint` before pushing.

## Repository structure

```
conductor/
├── packages/
│   ├── cli/              # TypeScript CLI (@houwert/conductor)
│   ├── android-driver/   # Kotlin/Gradle instrumentation driver
│   ├── ios-driver/       # Swift/Xcode XCTest driver
│   ├── ios-inproc/       # Library injected into the app for a second inspection plane
│   ├── ios-hid/          # Host binary injecting HID below the XCTest layer
│   ├── ios-capture/      # Host binary capturing the Simulator framebuffer
│   └── studio-ui/        # Design system for Conductor Studio
├── apps/
│   └── studio/           # Conductor Studio — the desktop app
└── Makefile
```

## Building locally

### Prerequisites

- Node.js and pnpm 10
- **iOS/tvOS:** Xcode with command-line tools
- **Android:** Android SDK with `adb` on `PATH`

### Full build

```bash
make build
```

Builds the iOS and tvOS XCTest drivers, the in-process library and capture binary (xcodebuild), and the Android driver (Gradle); packages them all into the CLI and compiles TypeScript. Then link it globally:

```bash
cd packages/cli && pnpm link --global
```

### CLI only

If the drivers are already built and packaged:

```bash
cd packages/cli
pnpm install && pnpm build
```

### Individual targets

```bash
make build-cli            # CLI TypeScript only
make build-ios-driver     # iOS XCTest driver
make build-android-driver # Android instrumentation driver
make package-cli          # Bundle drivers into CLI package
```

### Conductor Studio

```bash
pnpm dev:studio    # run it from source
```

## Development

```bash
pnpm dev       # TypeScript watch mode
pnpm lint      # ESLint + Prettier check
pnpm lint:fix  # Auto-fix formatting
pnpm test      # Run test suite
```

## Artwork

The app icon (`apps/studio/build/`), the driver app icons and the README images (`assets/`) are generated from one source. After changing the icon artwork, regenerate them from `apps/studio`:

```bash
pnpm build:icon         # Studio .icns/.png and the iOS/tvOS driver icons
pnpm build:readme-art   # README banner and section images, light and dark
```
