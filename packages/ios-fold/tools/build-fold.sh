#!/usr/bin/env bash
# Build the guest-side fold controller into
# packages/cli/drivers/ios-fold/conductor-fold.dylib (ad-hoc signed).
#
# Requires macOS + Xcode. This is a simulator dylib: it is injected into the
# booted device's locationd, so it builds against the iphonesimulator SDK.
set -euo pipefail

PKG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$PKG_ROOT/Sources/ConductorFold"
OUT_DIR="${1:-$PKG_ROOT/../cli/drivers/ios-fold}"
mkdir -p "$OUT_DIR"

echo "==> Compiling + linking"
xcrun --sdk iphonesimulator clang -O2 -fobjc-arc \
  -arch arm64 -mios-simulator-version-min=15.0 \
  -dynamiclib \
  -o "$OUT_DIR/conductor-fold.dylib" \
  "$SRC/ConductorFold.m" \
  -framework Foundation

echo "==> Ad-hoc signing"
codesign --force --sign - "$OUT_DIR/conductor-fold.dylib"

echo "==> Built $OUT_DIR/conductor-fold.dylib"
