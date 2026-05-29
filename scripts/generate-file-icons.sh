#!/usr/bin/env bash
# Regenerates the markdown file-type icons (RAISE-65) from the design
# source build/file-icons/md.svg:
#
#   build/file-icons/md.icns   — macOS (Finder)
#   build/file-icons/md.ico    — Windows (Explorer)
#
# These are the document icons shown for the claimed markdown extension
# family, distinct from the app icon (build/icon.png / build/icon.svg).
# electron-builder reads them via the `icon: build/file-icons/md` key on
# each fileAssociations entry, picking .icns on mac / .ico on win.
#
# Usage:
#   ./scripts/generate-file-icons.sh
#
# Requirements:
#   - Node 22 (`nvm use`) — the rasterizer runs via npx.
#   - macOS `iconutil` for the .icns step (ships with Xcode CLT). The
#     .ico step is cross-platform. Run this on macOS to refresh both.
#
# Run after editing md.svg, then commit the regenerated md.icns + md.ico
# alongside the SVG. The intermediate iconset PNGs are gitignored.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ICON_DIR="$ROOT/build/file-icons"
SVG="$ICON_DIR/md.svg"
ICONSET="$ICON_DIR/md.iconset"

if [[ ! -f "$SVG" ]]; then
  echo "error: $SVG not found" >&2
  exit 1
fi

# Render a PNG from the SVG at a given pixel width (square canvas).
#   render <width> <out-path>
render() {
  npx --yes @resvg/resvg-js-cli --fit-width "$1" "$SVG" "$2" >/dev/null
}

echo "Rendering iconset PNGs from md.svg..."
rm -rf "$ICONSET"
mkdir -p "$ICONSET"

# Apple iconset members. Each @2x is the 1x size doubled. Rendering
# every member directly from the SVG (rather than downscaling one large
# PNG) keeps each size crisp.
render 16   "$ICONSET/icon_16x16.png"
render 32   "$ICONSET/icon_16x16@2x.png"
render 32   "$ICONSET/icon_32x32.png"
render 64   "$ICONSET/icon_32x32@2x.png"
render 128  "$ICONSET/icon_128x128.png"
render 256  "$ICONSET/icon_128x128@2x.png"
render 256  "$ICONSET/icon_256x256.png"
render 512  "$ICONSET/icon_256x256@2x.png"
render 512  "$ICONSET/icon_512x512.png"
render 1024 "$ICONSET/icon_512x512@2x.png"

if command -v iconutil >/dev/null 2>&1; then
  echo "Building md.icns via iconutil..."
  iconutil -c icns "$ICONSET" -o "$ICON_DIR/md.icns"
else
  echo "warning: iconutil not found (macOS only) — skipping md.icns" >&2
fi

echo "Rendering ICO sizes and building md.ico..."
ICO_TMP="$(mktemp -d)"
trap 'rm -rf "$ICO_TMP" "$ICONSET"' EXIT
# png-to-ico always emits its own canonical size set (16/32/48/256)
# regardless of which source PNGs you pass — it ignores extra sizes
# like 24/64. So render only the sizes it actually keeps; supplying
# more is wasted work. The resulting multi-resolution .ico covers the
# Explorer sizes (16/32 list/detail views, 48 large icons, 256 extra
# large / thumbnails).
for size in 16 32 48 256; do
  render "$size" "$ICO_TMP/$size.png"
done
npx --yes png-to-ico \
  "$ICO_TMP/16.png" \
  "$ICO_TMP/32.png" \
  "$ICO_TMP/48.png" \
  "$ICO_TMP/256.png" \
  > "$ICON_DIR/md.ico"

echo "Done:"
echo "  $ICON_DIR/md.icns"
echo "  $ICON_DIR/md.ico"
