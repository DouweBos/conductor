#!/usr/bin/env bash
#
# Build libConductorInject.dylib for iphonesimulator (universal: arm64 + x86_64).
# Adhoc-signs the artefact and copies it to packages/cli/drivers/ios-dylib/.
#
# Mirrors packages/ios-driver/build-conductor-ios-runner.sh, but the dylib has
# no XCTest dependency so xcodebuild can target the SPM directly.
#
# Usage: ./scripts/build-conductor-inject.sh
#
# Run from the repo root. Honors:
#   DERIVED_DATA_DIR=<path>  Override derived-data location (default: packages/ios-dylib/derived-data)
#   ARCHS="arm64 x86_64"     Override architectures
set -euo pipefail

if [ "$(basename "$PWD")" != "conductor" ]; then
    echo "This script must be run from the conductor root directory"
    exit 1
fi

REPO_ROOT="$PWD"
DERIVED_DATA_DIR="${DERIVED_DATA_DIR:-$REPO_ROOT/packages/ios-dylib/derived-data}"
ARCHS="${ARCHS:-x86_64 arm64}"
# xcodebuild generates a single scheme per SPM, named after the Package itself
# (not the product). For `name: "libConductorInject"` in Package.swift, the
# scheme is `libConductorInject`. Confirm with `xcodebuild -list` if changed.
SCHEME="libConductorInject"
PACKAGE_DIR="$REPO_ROOT/packages/ios-dylib"
OUTPUT_DIR="$REPO_ROOT/packages/cli/drivers/ios-dylib"
OUTPUT_FILE="$OUTPUT_DIR/libConductorInject.dylib"

echo "Building $SCHEME for iphonesimulator (archs: $ARCHS)"

rm -rf "$DERIVED_DATA_DIR"
mkdir -p "$DERIVED_DATA_DIR"
mkdir -p "$OUTPUT_DIR"

# xcodebuild auto-detects a Package.swift when run from the package directory.
# No -workspace / -project flag is needed (and passing one would fail since
# the SPM is not an .xcworkspace).
(
    cd "$PACKAGE_DIR"
    xcodebuild build \
        -scheme "$SCHEME" \
        -destination "generic/platform=iOS Simulator" \
        -derivedDataPath "$DERIVED_DATA_DIR" \
        -configuration Release \
        ARCHS="$ARCHS" \
        ONLY_ACTIVE_ARCH=NO \
        CODE_SIGN_IDENTITY="-" \
        CODE_SIGNING_REQUIRED=NO \
        CODE_SIGNING_ALLOWED=NO
)

# SPM `.library(type: .dynamic, ...)` builds into one of several layouts
# depending on Xcode version. Probe known locations in priority order.
PRODUCTS_DIR="$DERIVED_DATA_DIR/Build/Products/Release-iphonesimulator"
BUILT_PATH=""
for candidate in \
    "$PRODUCTS_DIR/libConductorInject.dylib" \
    "$PRODUCTS_DIR/PackageFrameworks/ConductorInject.framework/ConductorInject" \
    "$PRODUCTS_DIR/ConductorInject.framework/ConductorInject"; do
    if [ -e "$candidate" ]; then
        BUILT_PATH="$candidate"
        break
    fi
done

if [ -z "$BUILT_PATH" ]; then
    echo "ERROR: could not locate built libConductorInject artefact under $PRODUCTS_DIR"
    find "$PRODUCTS_DIR" -maxdepth 4 -type f \( -name '*.dylib' -o -name 'ConductorInject' \) 2>/dev/null || true
    exit 1
fi

cp "$BUILT_PATH" "$OUTPUT_FILE"
chmod 0755 "$OUTPUT_FILE"

# Deliberately *not* running install_name_tool. Xcode's framework binary keeps
# its `@rpath/ConductorInject.framework/ConductorInject` install name, and
# DYLD_INSERT_LIBRARIES loads the dylib by absolute path so the install name
# doesn't have to be resolvable. Modifying load commands here was observed to
# leave the binary in a state the simulator's CODESIGNING enforcement rejects
# (page-hash mismatch crash on app launch) even after re-signing — so we leave
# the load commands alone.

# Adhoc-sign so dyld will accept the binary inside a sandboxed simulator app.
codesign -fs - "$OUTPUT_FILE"

echo "Built $OUTPUT_FILE"
file "$OUTPUT_FILE"
