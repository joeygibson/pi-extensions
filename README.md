# pi-extensions

[Pi](https://pi.dev) coding agent extensions.

| Extension | Description |
|-----------|-------------|
| **[github-prs](extensions/github-prs.ts)** | Shows your open GitHub PRs with reviewer approval status via `/prs`. |
| **[macos-notify](extensions/macos-notify.ts)** | Sends a native macOS notification when the agent finishes working. Shows elapsed time and tab info (Ghostty, iTerm2, Terminal.app), and flags the tab with an attention cue that clears when you return. |
| **[save](extensions/save.ts)** | Saves the last assistant message as markdown to a file via `/save [filepath]`. Auto-generates a filename from context if none is given. |
| **[security-guard](extensions/security-guard.ts)** | Blocks or prompts on dangerous bash commands, sensitive file writes, and sensitive file reads. Configurable via a TOML file. |

## ⚠️ Package Rename (v1.2.0+)

As of pi v0.74.0, the package has been renamed from `@mariozechner/pi-coding-agent`
to `@earendil-works/pi-coding-agent`. If you're on an older version of these
extensions, update to v1.2.0+ to stay compatible.

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

Or just the GitHub PRs extension:

```json
{
  "packages": [
    {
      "source": "git:github.com/joeygibson/pi-extensions",
      "extensions": ["extensions/github-prs.ts"]
    }
  ]
}
```

Or just the save extension:

```json
{
  "packages": [
    {
      "source": "git:github.com/joeygibson/pi-extensions",
      "extensions": ["extensions/save.ts"]
    }
  ]
}
```

## Extension Details

### github-prs

Registers a `/prs` command that fetches your open pull requests from GitHub and
displays them in a box-drawn table with ANSI colors. Each PR shows its number
(as a clickable hyperlink in supported terminals), title, and the approval
status of every reviewer.

Reviewer statuses:
- **✔** (green) — Approved
- **✘** (red) — Changes requested
- **●** (yellow) — Commented
- **○** (gray) — Dismissed
- **◌** (dim) — Pending (requested but hasn't reviewed yet)

The extension uses `gh pr list --author @me` under the hood, so it
automatically shows PRs for whoever is authenticated with the GitHub CLI. No
repo-specific configuration is needed.

**Prerequisites:**
- [GitHub CLI (`gh`)](https://cli.github.com/) installed and on your `PATH`
- Authenticated via `gh auth login`

### security-guard

Intercepts `tool_call` events and checks bash commands, file writes, and file
reads against a set of rules. Each rule specifies a substring pattern and an
action (`prompt`, `block`, or `allow`). When multiple rules match, the most
specific (longest pattern) wins — so you can create narrow `allow` exceptions
to broader `block` rules.

**Configuration:** On first load, an example config is written to
`~/.pi/agent/security-guard.toml.example`. Copy it to
`~/.pi/agent/security-guard.toml` and customize:

```toml
[operations]
rm -rf = prompt
sudo = prompt
dd if= = block
> /dev/ = block
> /dev/null = allow

[writes]
.env = block
~/.ssh = block

[reads]
~/.ssh = block
~/.aws/credentials = prompt
```

Without a config file, sensible defaults are used. Rules are reloaded on
`/reload`.

**Prompt highlighting:** When a command or path triggers a `prompt`, the
offending command segment is highlighted in red and wrapped in `»…«` markers
— from the trigger through its arguments — so dangerous operations like a
nested `rm -rf` are easy to spot. Highlighting stops at shell separators
(`&&`, `||`, `|`, `;`, newline), so neighboring commands stay uncolored.

### save

Registers a `/save` command that writes the last assistant message as markdown
to a file. Accepts an optional filepath argument:

- **`/save`** — auto-generates a filename from the content (e.g.
  `your-content-slug-202605261507.md`)
- **`/save notes/design`** — writes to `notes/design.md` (`.md` added if no
  extension is present)
- **`/save output.txt`** — writes to `output.txt` as-is

Runs entirely client-side — no LLM round-trip. Creates parent directories
automatically if they don't exist.

### macos-notify

Sends a native macOS notification (with pi's icon) when the agent has been
working for 3+ seconds and finishes. Includes tab name and number if
available. Supports **Ghostty**, **iTerm2**, and **Terminal.app** — the
terminal is detected automatically via `TERM_PROGRAM`. For unknown terminals,
all three are tried in sequence.

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

**Tab attention cue:** When the notification fires, the extension also flags the
tab so you can spot it at a glance:

- **iTerm2** — tints the tab title bar (orange) via an OSC 6 escape sequence.
- **Ghostty** — prepends a green dot (🟢) to the tab title via OSC 0, since
  Ghostty has no tab-color API.
- **Terminal.app / others** — no cue (Terminal.app can only tint the entire
  background, which is too intrusive).

The cue is cleared automatically when you return to the tab and submit your next
prompt, or when you quit / `/reload` / switch sessions.

The cue is automatically suppressed when pi is running inside a `herdr` pane
(detected via the `HERDR_*` env vars), since herdr already indicates which
agent needs attention.

## License

[MIT](LICENSE)
