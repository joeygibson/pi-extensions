# PiNotify.app

A minimal macOS app bundle that sends native notifications with pi's icon.

Using an `.app` bundle (rather than bare `osascript`) lets macOS display a
custom icon in Notification Center. `LSUIElement` keeps it out of the Dock,
and the process exits immediately after delivery.

## Build

A pre-built universal binary is checked into the repo, so most users don't need
to build anything. The `macos-notify` extension also auto-builds from source if
the binary is missing.

To rebuild manually (requires Xcode Command Line Tools):

```bash
xcode-select --install   # if not already installed
./build.sh
```

This produces `PiNotify.app` in this directory. The `macos-notify` extension
finds it here automatically.

## Test

```bash
open PiNotify.app --args "pi" "Hello from PiNotify!"
```

## Custom Icon

Replace `AppIcon.icns` with your own icon and rebuild. You can create an
`.icns` file from a 1024×1024 PNG using:

```bash
mkdir MyIcon.iconset
sips -z 1024 1024 icon.png --out MyIcon.iconset/icon_512x512@2x.png
iconutil -c icns MyIcon.iconset -o AppIcon.icns
```
