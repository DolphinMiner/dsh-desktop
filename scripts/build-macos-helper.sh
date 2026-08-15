#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "The macOS computer helper can only be built on macOS." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/native/macos/DSHComputerHelper.swift"
ENTITLEMENTS="$ROOT/native/macos/DSHComputerHelper.entitlements"
OUTPUT_DIR="${DSH_DESKTOP_HELPER_OUTPUT_DIR:-$ROOT/build/native}"
ARCHS="${DSH_DESKTOP_HELPER_ARCHS:-$(uname -m)}"
MIN_VERSION="${DSH_DESKTOP_MACOS_MIN_VERSION:-14.0}"
IDENTITY="${DSH_DESKTOP_CODESIGN_IDENTITY:--}"

mkdir -p "$OUTPUT_DIR/architectures"
parts=()
for arch in $ARCHS; do
  output="$OUTPUT_DIR/architectures/DSHComputerHelper-$arch"
  xcrun swiftc \
    -parse-as-library \
    -O \
    -whole-module-optimization \
    -target "$arch-apple-macos$MIN_VERSION" \
    -framework AppKit \
    -framework ApplicationServices \
    -framework CoreGraphics \
    -framework ScreenCaptureKit \
    -framework Vision \
    "$SOURCE" \
    -o "$output"
  parts+=("$output")
done

final="$OUTPUT_DIR/DSHComputerHelper"
if [[ ${#parts[@]} -eq 1 ]]; then
  cp "${parts[0]}" "$final"
else
  xcrun lipo -create "${parts[@]}" -output "$final"
fi
chmod 755 "$final"
codesign --force --options runtime --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$final"
codesign --verify --strict "$final"
