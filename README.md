# pi-extensions

[Pi](https://pi.dev) coding agent extensions.

| Extension | Description |
|-----------|-------------|
| **[github-prs](#github-prs)** | Shows your open GitHub PRs with reviewer approval status via `/prs`. ([source](extensions/github-prs.ts)) |
| **[review](#review)** | Spawns a fresh, isolated `pi` process to adversarially review your recent work (uncommitted, new files, or unpushed commits; finds the right worktree) via `/review [model] [--base <ref>] [--cwd <path>]`. ([source](extensions/review.ts)) |
| **[macos-notify](#macos-notify)** | Sends a native macOS notification when the agent finishes working. Shows elapsed time and tab info (Ghostty, iTerm2, Terminal.app), and flags the tab with an attention cue that clears when you return. ([source](extensions/macos-notify.ts)) |
| **[save](#save)** | Saves the last assistant message as markdown to a file via `/save [filepath]`. Auto-generates a filename from context if none is given. ([source](extensions/save.ts)) |
| **[security-guard](#security-guard)** | Blocks or prompts on dangerous bash commands, sensitive file writes, and sensitive file reads. Configurable via a TOML file. ([source](extensions/security-guard.ts)) |

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

Or just the review extension:

```json
{
  "packages": [
    {
      "source": "git:github.com/joeygibson/pi-extensions",
      "extensions": ["extensions/review.ts"]
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

### review

Registers a `/review [model]` command that spawns a **fresh, isolated `pi`
process** to adversarially review your uncommitted work. Because the reviewer
runs in its own context (`--no-session`) with read-only tools, it critiques the
current diff — bugs, security holes, missed edge cases, untested paths, and
anything that contradicts the apparent intent — without the main session's
momentum or self-confirmation bias.

- **`/review`** — review your recent work with the configured (or default)
  model (see **Review target** below).
- **`/review gpt-6.1-sol`** — override the reviewer model for this run (tab
  completion lists available models).
- **`/review --base main`** — review everything since the merge-base with
  `main` (committed + uncommitted + new files). Tab completion after `--base`
  lists branches/tags.
- **`/review gpt-6.1-sol --base HEAD~3`** — both at once.
- **`/review --cwd ~/.git-worktrees/XDR-1234-foo`** — review a specific
  directory/worktree instead of auto-detecting (tab completion after `--cwd`
  lists the repo's worktrees).

**Which directory gets reviewed.** The command works in git worktrees, which
matters when a pi session lives in your main clone but did its work on a branch
in a separate worktree. Before building the diff, `/review` scans the repo's
worktrees and picks the one with actual work (uncommitted changes **or** commits
ahead of its base):

- If your current directory has work, it's used (no prompt).
- Otherwise, if exactly one other worktree has work, it's auto-selected and you
  get a one-key confirm showing the path and scope before anything runs.
- If several worktrees have work, you're asked to pick.
- `--cwd <path>` skips detection entirely.

Whenever the reviewed directory isn't your current one — or the target falls
back to committed history — `/review` confirms (`Review <scope> in <path>?`)
**before** spending a model call, so it can't silently review the wrong thing.

**Model precedence** (highest first): the `/review <model>` argument, then
`model` in `~/.pi/agent/review.toml`, then the built-in default
(`gpt-6.1-sol`).

**Review target** — what gets diffed, resolved in this order:

1. **`--base <ref>`** — everything since the merge-base with `<ref>`
   (committed + uncommitted), plus new files.
2. **`diff_command`** (if set in config) — run verbatim; its stdout is the
   review.
3. **Uncommitted work** — `git diff HEAD` **plus untracked/new files**, so a
   brand-new module you haven't added yet still gets reviewed.
4. **Unpushed commits** — fallback when the working tree is clean: vs
   `@{upstream}`, else `origin/main`/`origin/master` (or local `main`/
   `master`), else `HEAD~1`. This is why **"commit everything, then run
   `/review`" still works** — it reviews the commits instead of an empty diff.

If none of those produce a diff, `/review` reports there's nothing to do.

**Configuration:** optional `~/.pi/agent/review.toml` (all keys optional):

```toml
model              = "gpt-6.1-sol"   # reviewer model
thinking           = "high"          # reviewer thinking level
extra_instructions = ""              # appended to the reviewer prompt
feedback           = "discuss"       # discuss | auto | off
include_untracked  = true            # include new/untracked files (default)
diff_command       = ""              # advanced: full override of the target
```

The `feedback` key controls what happens once the critique is ready:

- **`discuss`** (default) — the critique is injected as a user message that
  tells your current agent to walk you through the findings **without editing
  anything**, then wait for your go-ahead before changing code. Nothing is
  touched until you approve.
- **`auto`** — the critique is injected and the agent fixes the findings
  immediately. Opt in only if you want a hands-off loop.
- **`off`** — the critique is displayed read-only and no turn is triggered;
  you read it yourself and decide what to do.

Setting `include_untracked = false` skips new/untracked files. Setting
`diff_command` to a non-empty command overrides the whole target-resolution
logic above (you own the diff). The diff is streamed to the reviewer on stdin
(so large diffs don't hit argv limits), new files are size-capped so a huge or
binary file can't blow the context window, and progress shows in the footer.

**Prerequisites:**
- `git` on your `PATH`
- Credentials for the reviewer model's provider

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

**Approval notifications:** When a rule triggers a `prompt`, pi blocks and
waits for your answer — which is easy to miss if you've stepped away. To catch
your attention, security-guard fires a native macOS notification titled
**“pi — approval needed”** (with the `Submarine` sound) the moment the prompt
appears, and re-fires it every 30 seconds until you respond. This is distinct
from the one-shot “Done” toast that [macos-notify](#macos-notify) shows on
completion, so you can tell “pi finished” apart from “pi needs me.” The
notification reuses the same `PiNotify.app` bundle as macos-notify; if that app
isn't available the prompt still works, just without the toast. The sound and
interval are constants (`APPROVAL_SOUND`, `NUDGE_INTERVAL_MS`) at the top of
`extensions/security-guard.ts`.

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
