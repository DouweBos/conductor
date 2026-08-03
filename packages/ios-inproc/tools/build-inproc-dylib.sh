#!/bin/bash
set -euo pipefail

# Build the Conductor in-process control library as a dynamic framework for the
# iOS or tvOS Simulator, ready to inject via SIMCTL_CHILD_DYLD_INSERT_LIBRARIES.
#
# Output: packages/cli/drivers/<ios|tvos>-inproc/Conductor.framework/Conductor
#
# Usage:
#   ./tools/build-inproc-dylib.sh                 # iOS (host sim arch)
#   ./tools/build-inproc-dylib.sh --platform tvos # tvOS
#   ./tools/build-inproc-dylib.sh --all           # both iOS and tvOS
#   ./tools/build-inproc-dylib.sh --clean         # clean before building

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"                      # packages/ios-inproc
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"
SRC_DIR="$PKG_DIR/Conductor"

CLEAN=""
PLATFORMS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --clean)    CLEAN=1; shift ;;
        --platform) PLATFORMS+=("$2"); shift 2 ;;
        --all)      PLATFORMS+=(ios tvos); shift ;;
        *) shift ;;
    esac
done
[[ ${#PLATFORMS[@]} -eq 0 ]] && PLATFORMS=(ios)

info() { echo "inproc: $*"; }

build_one() {
    local platform="$1"
    local sdk_name target_os_min sdk_platform out_subdir
    if [[ "$platform" == "tvos" ]]; then
        sdk_name="appletvsimulator"
        sdk_platform="tvos"
        target_os_min="${TVOS_TARGET_VERSION:-15.0}"
        out_subdir="tvos-inproc"
    else
        sdk_name="iphonesimulator"
        sdk_platform="ios"
        target_os_min="${IOS_TARGET_VERSION:-15.0}"
        out_subdir="ios-inproc"
    fi

    local framework_dir="$REPO_ROOT/packages/cli/drivers/$out_subdir/Conductor.framework"
    [[ -n "$CLEAN" ]] && { info "cleaning $framework_dir"; rm -rf "$framework_dir"; }

    local arch target sdk_path
    arch="$(uname -m)"
    [[ "$arch" != "arm64" ]] && arch="x86_64"
    target="${arch}-apple-${sdk_platform}${target_os_min}-simulator"
    sdk_path="$(xcrun --sdk "$sdk_name" --show-sdk-path)"

    info "[$platform] target: $target"
    info "[$platform] sdk:    $sdk_path"

    mkdir -p "$framework_dir/Modules/Conductor.swiftmodule"

    local swift_files=() c_files=() m_files=() mm_files=()
    while IFS= read -r -d '' f; do swift_files+=("$f"); done < <(find "$SRC_DIR" -name '*.swift' -print0)
    while IFS= read -r -d '' f; do c_files+=("$f"); done < <(find "$SRC_DIR" -name '*.c' -print0)
    while IFS= read -r -d '' f; do m_files+=("$f"); done < <(find "$SRC_DIR" -name '*.m' -print0)
    while IFS= read -r -d '' f; do mm_files+=("$f"); done < <(find "$SRC_DIR" -name '*.mm' -print0)
    info "[$platform] compiling ${#swift_files[@]} Swift + ${#c_files[@]} C + ${#m_files[@]} ObjC + ${#mm_files[@]} ObjC++ files"

    # Compile C/ObjC to objects; build a bridging header importing every ObjC .h
    # so Swift can call the exception-catcher etc.
    local build_tmp="$framework_dir/.build-$arch"
    rm -rf "$build_tmp"; mkdir -p "$build_tmp"
    local objects=() bridging=""
    for c in "${c_files[@]}"; do
        local o="$build_tmp/$(basename "${c%.c}").o"
        xcrun -sdk "$sdk_name" clang -target "$target" -isysroot "$sdk_path" -c "$c" -o "$o"
        objects+=("$o")
    done
    for m in "${m_files[@]}"; do
        local o="$build_tmp/$(basename "${m%.m}")_objc.o"
        xcrun -sdk "$sdk_name" clang -target "$target" -isysroot "$sdk_path" -fobjc-arc -c "$m" -o "$o"
        objects+=("$o")
    done
    # ObjC++ (.mm) — C++ interop shims (React Native Fabric props). -std=c++17 to
    # match RN/folly; libc++. The real react::Props path lights up only when RN
    # headers are on -I (see ReactPropsBridge.mm's __has_include guard).
    for mm in "${mm_files[@]}"; do
        local o="$build_tmp/$(basename "${mm%.mm}")_objcpp.o"
        xcrun -sdk "$sdk_name" clang++ -target "$target" -isysroot "$sdk_path" \
            -fobjc-arc -std=c++17 -stdlib=libc++ -c "$mm" -o "$o"
        objects+=("$o")
    done
    # Bridging header imports every .h (ObjC catcher, C heap scanner, …) so Swift can call them.
    local h_files=()
    while IFS= read -r -d '' f; do h_files+=("$f"); done < <(find "$SRC_DIR" -name '*.h' -print0)
    if [[ ${#h_files[@]} -gt 0 ]]; then
        bridging="$build_tmp/Conductor-Bridging-Header.h"
        : > "$bridging"
        for h in "${h_files[@]}"; do echo "#import \"$h\"" >> "$bridging"; done
    fi

    xcrun -sdk "$sdk_name" swiftc \
        -target "$target" \
        -sdk "$sdk_path" \
        -emit-library \
        -emit-module \
        -emit-module-path "$framework_dir/Modules/Conductor.swiftmodule/${arch}.swiftmodule" \
        -module-name Conductor \
        -o "$framework_dir/Conductor" \
        -Osize \
        -framework UIKit \
        -framework Foundation \
        -framework Network \
        -Xlinker -install_name -Xlinker @rpath/Conductor.framework/Conductor \
        ${bridging:+-import-objc-header "$bridging"} \
        "${swift_files[@]}" \
        "${objects[@]}"

    cat > "$framework_dir/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key><string>dev.houwert.conductor.inproc</string>
    <key>CFBundleName</key><string>Conductor</string>
    <key>CFBundleExecutable</key><string>Conductor</string>
    <key>CFBundlePackageType</key><string>FMWK</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>MinimumOSVersion</key><string>${target_os_min}</string>
</dict>
</plist>
PLIST

    # Ad-hoc sign — REQUIRED. iOS/tvOS 26.3+ simulators silently refuse a
    # DYLD_INSERT dylib carrying only a linker signature (no error; never loads).
    codesign --force --sign - --deep "$framework_dir"

    local size_kb=$(( $(stat -f%z "$framework_dir/Conductor") / 1024 ))
    info "[$platform] built Conductor.framework (${size_kb}KB) → $framework_dir/Conductor"
}

for p in "${PLATFORMS[@]}"; do
    build_one "$p"
done
