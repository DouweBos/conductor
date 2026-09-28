#!/usr/bin/env bash
# Give the macOS driver app and its XCTest Runner.app an icon, then re-sign.
#
# Same gap as brand-runner.sh: XCTRunner's template has no icon hook. The
# runner is sandboxed with entitlements it needs to serve HTTP, so the re-sign
# keeps them.
#
# Usage: brand-mac-runner.sh <icon.icns> <app>...
set -euo pipefail

ICNS="$1"
shift
PB=/usr/libexec/PlistBuddy

for APP in "$@"; do
  mkdir -p "$APP/Contents/Resources"
  cp "$ICNS" "$APP/Contents/Resources/AppIcon.icns"
  $PB -c "Delete :CFBundleIconFile" "$APP/Contents/Info.plist" 2>/dev/null || true
  $PB -c "Add :CFBundleIconFile string AppIcon" "$APP/Contents/Info.plist"
  codesign --force --sign - --timestamp=none --preserve-metadata=entitlements "$APP"
done
