# pi-extensions

[Pi](https://github.com/badlogic/pi) coding agent extensions.

| Extension | Description |
|-----------|-------------|
| **[security-guard](extensions/security-guard.ts)** | Blocks or prompts on dangerous bash commands, sensitive file writes, and sensitive file reads. Configurable via a TOML file. |
| **[macos-notify](extensions/macos-notify.ts)** | Sends a native macOS notification when the agent finishes working. Shows elapsed time and Ghostty tab info. |

## Install All Extensions

```bash
pi install git:github.com/joeygibson/pi-extensions
```

## Install Selectively

To install only one extension, add to your `~/.pi/agent/settings.json`
(or `.pi/settings.json` for project-local):

```json
{
  "packages": [
    {
      "source": "git:github.com/joeygibson/pi-extensions",
      "extensions": ["extensions/security-guard.ts"]
    }
  ]
}
```

Or just the notification extension:

```json
{
  "packages": [
    {
      "source": "git:github.com/joeygibson/pi-extensions",
      "extensions": ["extensions/macos-notify.ts"]
    }
  ]
}
```

## Extension Details

### security-guard

Intercepts `tool_call` events and checks bash commands, file writes, and file
reads against a set of rules. Each rule specifies a substring pattern and an
action (`prompt` or `block`).

**Configuration:** On first load, an example config is written to
`~/.pi/agent/security-guard.toml.example`. Copy it to
`~/.pi/agent/security-guard.toml` and customize:

```toml
[operations]
rm -rf = prompt
sudo = prompt
dd if= = block

[writes]
.env = block
~/.ssh = block

[reads]
~/.ssh = block
~/.aws/credentials = prompt
```

Without a config file, sensible defaults are used. Rules are reloaded on
`/reload`.

### macos-notify

Sends a native macOS notification (with pi's icon) when the agent has been
working for 3+ seconds and finishes. Includes Ghostty tab name and number if
available.

This extension requires a small native macOS app bundle (`PiNotify.app`) to
deliver notifications. Using an `.app` bundle — rather than bare `osascript` —
is what lets macOS show pi's icon in Notification Center. The app is a ~100KB
Swift binary that runs `display notification` via NSAppleScript, then exits. It
never appears in the Dock (`LSUIElement`).

A pre-built **universal binary** (arm64 + x86\_64) is checked into the repo
under [`macos-notify-app/`](macos-notify-app/), so `pi install` works with no
extra steps. The full source (`PiNotify.swift`) and build script are in the
same directory. If the binary is missing for any reason, the extension
automatically rebuilds it from source on first load (requires Xcode Command
Line Tools). You can also rebuild manually:

```bash
cd macos-notify-app
./build.sh
```

See [macos-notify-app/README.md](macos-notify-app/README.md) for details.

## License

[MIT](LICENSE)
