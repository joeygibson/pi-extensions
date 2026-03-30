#!/usr/bin/env bash
#
# Build PiNotify.app from source.
#
# Prerequisites: Xcode Command Line Tools (xcode-select --install)
#
# The built .app bundle lands in this directory (macos-notify-app/PiNotify.app).
# The macos-notify extension finds it here automatically.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${SCRIPT_DIR}/PiNotify.app"

echo "Building PiNotify.app..."

# Clean previous build
rm -rf "${APP_DIR}"

# Create .app bundle structure
mkdir -p "${APP_DIR}/Contents/MacOS"
mkdir -p "${APP_DIR}/Contents/Resources"

# Copy Info.plist
cp "${SCRIPT_DIR}/Info.plist" "${APP_DIR}/Contents/"

# Copy icon if present
if [[ -f "${SCRIPT_DIR}/AppIcon.icns" ]]; then
    cp "${SCRIPT_DIR}/AppIcon.icns" "${APP_DIR}/Contents/Resources/"
else
    echo "Warning: AppIcon.icns not found. Notifications will use a generic icon."
    echo "         Place an AppIcon.icns file in ${SCRIPT_DIR}/ and rebuild."
fi

# Compile - universal binary for both Apple Silicon and Intel
swiftc \
    -O \
    -target arm64-apple-macos13.0 \
    -o "${APP_DIR}/Contents/MacOS/PiNotify-arm64" \
    "${SCRIPT_DIR}/PiNotify.swift"

swiftc \
    -O \
    -target x86_64-apple-macos13.0 \
    -o "${APP_DIR}/Contents/MacOS/PiNotify-x86_64" \
    "${SCRIPT_DIR}/PiNotify.swift"

lipo -create \
    "${APP_DIR}/Contents/MacOS/PiNotify-arm64" \
    "${APP_DIR}/Contents/MacOS/PiNotify-x86_64" \
    -output "${APP_DIR}/Contents/MacOS/PiNotify"

# Clean up intermediates
rm "${APP_DIR}/Contents/MacOS/PiNotify-arm64" \
   "${APP_DIR}/Contents/MacOS/PiNotify-x86_64"

echo "Built: ${APP_DIR}"
echo ""
echo "Test it with:"
echo "  open '${APP_DIR}' --args 'pi' 'Hello from PiNotify!'"
