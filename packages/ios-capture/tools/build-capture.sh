#!/usr/bin/env bash
# Build the host-side simulator framebuffer capture binary into
# packages/cli/drivers/ios-capture/conductor-capture (ad-hoc signed).
#
# Requires macOS + Xcode. Links against private CoreSimulator/SimulatorKit
# frameworks at runtime via dlopen (not at build time), so the build itself
# only needs the public SDK.
set -euo pipefail

PKG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$PKG_ROOT/Sources/ConductorCapture"
OUT_DIR="${1:-$PKG_ROOT/../cli/drivers/ios-capture}"
mkdir -p "$OUT_DIR"

BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

echo "==> Compiling ObjC capture core"
clang -c -O2 -fobjc-arc -o "$BUILD/inject.o" "$SRC/CaptureInject.m"

echo "==> Compiling + linking Swift"
swiftc -O \
  -o "$OUT_DIR/conductor-capture" \
  "$SRC/CaptureBridge.swift" "$SRC/main.swift" "$BUILD/inject.o" \
  -framework Foundation -framework CoreGraphics -framework CoreMedia \
  -framework CoreVideo -framework VideoToolbox -framework IOSurface -framework AppKit

echo "==> Ad-hoc signing"
codesign --force --sign - "$OUT_DIR/conductor-capture"

echo "==> Built $OUT_DIR/conductor-capture"
