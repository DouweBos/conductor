#!/usr/bin/env bash
# Give an XCTest Runner.app its host app's icon, then re-sign it ad-hoc.
#
# Xcode builds the runner from its XCTRunner template, which has no icon and no
# build setting to add one, so it shows up as a blank tile next to the driver.
# Simulator slices only: device runners are signed with the user's team.
#
# Usage: brand-runner.sh <host.app> <Runner.app>
set -euo pipefail

HOST="$1"
RUNNER="$2"
PB=/usr/libexec/PlistBuddy

cp "$HOST/Assets.car" "$RUNNER/"
find "$HOST" -maxdepth 1 -name 'AppIcon*.png' -exec cp {} "$RUNNER/" \;

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
for key in CFBundleIcons 'CFBundleIcons~ipad' TVTopShelfImage; do
  $PB -x -c "Print :$key" "$HOST/Info.plist" >"$TMP" 2>/dev/null || continue
  $PB -c "Delete :$key" "$RUNNER/Info.plist" 2>/dev/null || true
  $PB -c "Add :$key dict" -c "Merge $TMP :$key" "$RUNNER/Info.plist"
done

codesign --force --sign - --timestamp=none "$RUNNER"
