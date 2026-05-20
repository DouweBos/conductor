#!/usr/bin/env bash
#
# Build conductor-sim-driver — host macOS binary that drives HID events into
# a booted iOS simulator via CoreSimulator.framework + IOKit IOHIDEvent SPI.
#
# Universal binary (arm64 + x86_64), adhoc-signed, output to
#   packages/cli/drivers/ios-sim-driver/conductor-sim-driver
#
# Run from the conductor repo root.
#
set -euo pipefail

if [ "$(basename "$PWD")" != "conductor" ]; then
    echo "This script must be run from the conductor root directory"
    exit 1
fi

REPO_ROOT="$PWD"
PACKAGE_DIR="$REPO_ROOT/packages/ios-sim-driver"
OUTPUT_DIR="$REPO_ROOT/packages/cli/drivers/ios-sim-driver"
OUTPUT_FILE="$OUTPUT_DIR/conductor-sim-driver"
DERIVED="${DERIVED_DATA_DIR:-$PACKAGE_DIR/.build}"

mkdir -p "$OUTPUT_DIR"

echo "Building conductor-sim-driver (universal: arm64 + x86_64)"

# Build for both arches via two single-arch invocations, then lipo. swift build
# accepts --arch but only one at a time — universal binaries are post-merged.
cd "$PACKAGE_DIR"

ARCH_BINS=()
for ARCH in arm64 x86_64; do
    BUILD_DIR="$DERIVED/$ARCH"
    rm -rf "$BUILD_DIR"
    mkdir -p "$BUILD_DIR"
    echo "  → building $ARCH"
    swift build -c release \
        --arch "$ARCH" \
        --build-path "$BUILD_DIR"
    ARCH_BIN="$BUILD_DIR/$ARCH-apple-macosx/release/conductor-sim-driver"
    if [ ! -f "$ARCH_BIN" ]; then
        echo "ERROR: missing build output: $ARCH_BIN"
        find "$BUILD_DIR" -name conductor-sim-driver 2>/dev/null || true
        exit 1
    fi
    ARCH_BINS+=("$ARCH_BIN")
done

echo "Merging into universal binary"
lipo -create "${ARCH_BINS[@]}" -output "$OUTPUT_FILE"
chmod 0755 "$OUTPUT_FILE"

# Adhoc sign so dyld accepts it on Gatekeeper-enabled Macs.
codesign -fs - "$OUTPUT_FILE"

echo "Built $OUTPUT_FILE"
file "$OUTPUT_FILE"
