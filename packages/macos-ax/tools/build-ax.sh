#!/usr/bin/env bash
# Build the background macOS driver into
# packages/cli/drivers/macos-ax/ConductorAX.app (universal). Set
# CONDUCTOR_SIGN_IDENTITY to sign with a developer identity; defaults to ad-hoc.
#
# It's an app bundle rather than a bare binary so macOS attributes the
# Accessibility and Screen Recording grants to it, not to whichever terminal or
# IDE happened to start conductor.
set -euo pipefail

PKG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$PKG_ROOT/Sources/ConductorAX"
ICON="$PKG_ROOT/../../apps/studio/build/icon.icns"
OUT_DIR="${1:-$PKG_ROOT/../cli/drivers/macos-ax}"
APP="$OUT_DIR/ConductorAX.app"

BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

for arch in arm64 x86_64; do
  echo "==> Compiling $arch"
  swiftc -O -target "$arch-apple-macos14" -o "$BUILD/conductor-ax-$arch" "$SRC"/*.swift \
    -framework AppKit -framework ApplicationServices -framework ScreenCaptureKit -framework Network
done

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$ICON" "$APP/Contents/Resources/AppIcon.icns"
lipo -create -output "$APP/Contents/MacOS/conductor-ax" "$BUILD"/conductor-ax-*
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.houwert.conductor-ax</string>
  <key>CFBundleName</key><string>ConductorAX</string>
  <key>CFBundleExecutable</key><string>conductor-ax</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# A real identity keeps the Accessibility / Screen Recording grants across
# rebuilds; ad-hoc signatures are keyed to the exact binary, so every rebuild
# asks again.
IDENTITY="${CONDUCTOR_SIGN_IDENTITY:--}"
echo "==> Signing (${IDENTITY/#-/ad-hoc})"
codesign --force --sign "$IDENTITY" --identifier dev.houwert.conductor-ax "$APP"

echo "==> Built $APP"
