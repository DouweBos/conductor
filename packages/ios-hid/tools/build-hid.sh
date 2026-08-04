#!/usr/bin/env bash
# Build the host-side CoreSimulator HID injector into
# packages/cli/drivers/ios-hid/conductor-hid (ad-hoc signed).
#
# Requires macOS + Xcode. Links against private CoreSimulator/SimulatorKit
# frameworks at runtime via dlopen (not at build time), so the build itself
# only needs the public SDK.
set -euo pipefail

PKG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$PKG_ROOT/Sources/ConductorHID"
OUT_DIR="${1:-$PKG_ROOT/../cli/drivers/ios-hid}"
mkdir -p "$OUT_DIR"

BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

echo "==> Compiling ObjC injection core"
clang -c -O2 -fobjc-arc -o "$BUILD/inject.o" "$SRC/ConductorHIDInject.m"

echo "==> Compiling + linking Swift"
swiftc -O \
  -o "$OUT_DIR/conductor-hid" \
  "$SRC/HIDBridge.swift" "$SRC/main.swift" "$BUILD/inject.o" \
  -framework Foundation -framework AppKit -framework CoreGraphics

echo "==> Ad-hoc signing"
codesign --force --sign - "$OUT_DIR/conductor-hid"

echo "==> Built $OUT_DIR/conductor-hid"
