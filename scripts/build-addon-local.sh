#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="${1:-$REPO_ROOT/build/addon/cgateweb}"
VERSION="${2:-local}"

echo "=== Building C-Gate Web Bridge Home Assistant Add-on ==="
echo "  Source:  $REPO_ROOT"
echo "  Output:  $OUTPUT_DIR"
echo "  Version: $VERSION"
echo ""

if [[ -d "$OUTPUT_DIR" ]]; then
    echo "Cleaning previous build..."
    rm -rf "$OUTPUT_DIR"
fi
mkdir -p "$OUTPUT_DIR"

echo "Copying addon metadata..."
cp "$REPO_ROOT/homeassistant-addon/config.yaml"    "$OUTPUT_DIR/"
cp "$REPO_ROOT/homeassistant-addon/Dockerfile"      "$OUTPUT_DIR/"
cp "$REPO_ROOT/homeassistant-addon/build.yaml"      "$OUTPUT_DIR/"
cp "$REPO_ROOT/homeassistant-addon/run.sh"          "$OUTPUT_DIR/"
cp "$REPO_ROOT/homeassistant-addon/DOCS.md"         "$OUTPUT_DIR/"
cp "$REPO_ROOT/homeassistant-addon/CHANGELOG.md"    "$OUTPUT_DIR/"
cp "$REPO_ROOT/homeassistant-addon/README.md"       "$OUTPUT_DIR/"
cp "$REPO_ROOT/homeassistant-addon/icon.png"        "$OUTPUT_DIR/"
cp "$REPO_ROOT/homeassistant-addon/logo.png"        "$OUTPUT_DIR/"

echo "Copying translations..."
cp -r "$REPO_ROOT/homeassistant-addon/translations" "$OUTPUT_DIR/"

echo "Copying rootfs (s6-overlay services)..."
cp -r "$REPO_ROOT/homeassistant-addon/rootfs"       "$OUTPUT_DIR/"

echo "Copying application source..."
cp -r "$REPO_ROOT/src"            "$OUTPUT_DIR/"
cp    "$REPO_ROOT/index.js"       "$OUTPUT_DIR/"
cp    "$REPO_ROOT/package.json"   "$OUTPUT_DIR/"
cp    "$REPO_ROOT/package-lock.json" "$OUTPUT_DIR/"

if [[ "$VERSION" != "local" ]]; then
    echo "Stamping version: $VERSION"
    sed -i.bak "s/^version: .*/version: \"$VERSION\"/" "$OUTPUT_DIR/config.yaml"
    rm -f "$OUTPUT_DIR/config.yaml.bak"
fi

echo ""
echo "Build complete!"
echo ""
echo "  $OUTPUT_DIR"
echo ""
ls -la "$OUTPUT_DIR/"
echo ""
echo "To deploy to Home Assistant via Samba:"
echo "  1. Mount the HA 'addons' share: smb://<ha-ip>/addons"
echo "  2. Copy the entire '$OUTPUT_DIR' folder into the share"
echo "     so the path is /addons/cgateweb/"
echo "  3. In HA: Settings -> Add-ons -> Add-on Store -> ⋮ -> Check for updates"
echo "  4. The addon should appear under 'Local add-ons'"
