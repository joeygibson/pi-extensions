/**
 * macOS Native Notification Extension
 *
 * Sends a native macOS notification with pi's icon when the agent finishes
 * working and is waiting for input.
 *
 * Uses PiNotify.app (NSAppleScript `display notification` inside a proper
 * .app bundle so macOS shows the pi logo).
 *
 * Features:
 *   - Includes tab name & number in the notification (Ghostty, iTerm2, Terminal.app)
 *   - Only notifies after 3+ seconds of work (avoids spam)
 *   - No Dock icon (LSUIElement), app exits after delivery
 *
 * PiNotify.app is included pre-built. If missing, the extension auto-builds
 * from source (requires Xcode Command Line Tools). See macos-notify-app/.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { writeSync, openSync, closeSync } from "node:fs";
import { basename } from "node:path";
import { resolveAppPath, sendNotification } from "../lib/pi-notify.ts";

const MIN_DURATION_MS = 3000;

/** Attention color for the iTerm2 tab when the agent finishes (R, G, B, 0-255). */
const ATTENTION_COLOR: [number, number, number] = [230, 126, 34]; // orange

/** Marker prepended to the Ghostty tab title to draw attention. */
const TAB_MARKER = "\uD83D\uDFE2 "; // 🟢 + space

/**
 * Write raw bytes directly to the controlling terminal (/dev/tty) rather than
 * stdout, so we don't interleave with / corrupt the pi TUI's own rendering.
 * OSC sequences are non-printing and consumed by the terminal.
 */
function writeToTty(data: string): void {
  try {
    const fd = openSync("/dev/tty", "w");
    try {
      writeSync(fd, data);
    } finally {
      closeSync(fd);
    }
  } catch {
    // No controlling tty (e.g. running headless) — silently skip.
  }
}

/**
 * iTerm2 tab title-bar color control via OSC 6 escape sequences.
 * These are only interpreted by iTerm2; other terminals ignore them.
 */
function setITermTabColor([r, g, b]: [number, number, number]): void {
  writeToTty(
    `\x1b]6;1;bg;red;brightness;${r}\x07` +
      `\x1b]6;1;bg;green;brightness;${g}\x07` +
      `\x1b]6;1;bg;blue;brightness;${b}\x07`
  );
}

/** Reset the iTerm2 tab color back to the profile default. */
function resetITermTabColor(): void {
  writeToTty(`\x1b]6;1;bg;*;default\x07`);
}

/**
 * Set the terminal/tab title via OSC 0. In Ghostty this updates the tab label
 * for *our* surface (the one bound to this TTY). Ghostty has no tab-color API,
 * so a title marker is the closest attention cue available.
 */
function setTabTitle(title: string): void {
  writeToTty(`\x1b]0;${title}\x07`);
}

/** The base pi title for a given cwd, matching what pi/the shell set. */
function baseTitle(cwd: string): string {
  return `\u03c0 - ${basename(cwd)}`; // "π - <project>"
}

type TabAttention = "iterm-color" | "ghostty-title" | "none";

/**
 * Whether pi is running inside a herdr pane. herdr injects HERDR_* env vars
 * into child processes and already surfaces which agent needs attention, so we
 * skip our own tab cue to avoid redundant (and conflicting) signalling.
 */
function runningInHerdr(): boolean {
  return Boolean(process.env.HERDR_PANE_ID ?? process.env.HERDR_SESSION);
}

/**
 * Decide which tab-attention mechanism to use for the current terminal.
 *   - herdr    → nothing (herdr already indicates the agent needing attention)
 *   - iTerm2  → OSC 6 tab color (native tab tint)
 *   - Ghostty → OSC 0 title marker (no color API exists)
 *   - others  → nothing (Terminal.app can only tint the whole background)
 */
function tabAttentionMode(): TabAttention {
  if (runningInHerdr()) return "none";
  switch (process.env.TERM_PROGRAM ?? "") {
    case "iTerm.app":
      return "iterm-color";
    case "ghostty":
      return "ghostty-title";
    default:
      return "none";
  }
}

/** Apply the attention cue to our tab. Returns true if anything was applied. */
function markTabAttention(cwd: string): boolean {
  switch (tabAttentionMode()) {
    case "iterm-color":
      setITermTabColor(ATTENTION_COLOR);
      return true;
    case "ghostty-title":
      setTabTitle(TAB_MARKER + baseTitle(cwd));
      return true;
    default:
      return false;
  }
}

/** Remove the attention cue, restoring the tab to its normal state. */
function clearTabAttention(cwd: string): void {
  switch (tabAttentionMode()) {
    case "iterm-color":
      resetITermTabColor();
      break;
    case "ghostty-title":
      setTabTitle(baseTitle(cwd));
      break;
    default:
      break;
  }
}

/** Run an AppleScript and return stdout, or null on error/timeout. */
function runOsascript(script: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/osascript",
      ["-e", script],
      { timeout: 3000 },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(null);
          return;
        }
        resolve(stdout);
      }
    );
  });
}

/**
 * Parse tab-number + title lines ("1\tTitle\n2\tTitle\n") and return
 * the first tab whose title contains the expected pi title.
 */
function matchTab(
  output: string,
  expectedTitle: string
): { tabNumber: number; tabTitle: string } | null {
  for (const line of output.trim().split("\n")) {
    const [numStr, title] = line.split("\t");
    if (title && title.trim() === expectedTitle) {
      return {
        tabNumber: parseInt(numStr, 10),
        tabTitle: title.trim(),
      };
    }
  }
  return null;
}

/** Query Ghostty tabs via System Events accessibility API. */
function findGhosttyTab(
  expectedTitle: string
): Promise<{ tabNumber: number; tabTitle: string } | null> {
  const script = `
    tell application "System Events"
      tell process "Ghostty"
        tell tab group "tab bar" of window 1
          set tabList to every radio button
          set resultLines to ""
          repeat with i from 1 to count of tabList
            set t to item i of tabList
            set resultLines to resultLines & i & "\\t" & (title of t) & "\\n"
          end repeat
          return resultLines
        end tell
      end tell
    end tell
  `;

  return runOsascript(script).then((out) =>
    out ? matchTab(out, expectedTitle) : null
  );
}

/** Query iTerm2 tabs via its native scripting dictionary. */
function findITerm2Tab(
  expectedTitle: string
): Promise<{ tabNumber: number; tabTitle: string } | null> {
  // iTerm2 session "name" reflects the escape-sequence-set title (e.g. "π - project").
  // We iterate all windows and tabs to find a matching session.
  const script = `
    tell application "iTerm2"
      set resultLines to ""
      set tabIndex to 1
      repeat with w in windows
        repeat with t in tabs of w
          tell current session of t
            set resultLines to resultLines & tabIndex & "\\t" & name & "\\n"
          end tell
          set tabIndex to tabIndex + 1
        end repeat
      end repeat
      return resultLines
    end tell
  `;

  return runOsascript(script).then((out) =>
    out ? matchTab(out, expectedTitle) : null
  );
}

/** Query Terminal.app tabs via its native scripting dictionary. */
function findTerminalAppTab(
  expectedTitle: string
): Promise<{ tabNumber: number; tabTitle: string } | null> {
  // Terminal.app does not directly expose the escape-sequence-set title via
  // AppleScript.  However, the window "name" includes it alongside the
  // custom title, shell, and dimensions (e.g. "dir — title — zsh — 80×24").
  // We check both the custom title and the window name for a match.
  const script = `
    tell application "Terminal"
      set resultLines to ""
      set tabIndex to 1
      repeat with w in windows
        set wName to name of w
        set tabCount to count of tabs of w
        repeat with i from 1 to tabCount
          set t to tab i of w
          -- Prefer custom title; fall back to window name for title matching
          set cTitle to custom title of t
          if cTitle is not "" then
            set resultLines to resultLines & tabIndex & "\\t" & cTitle & "\\n"
          else
            set resultLines to resultLines & tabIndex & "\\t" & wName & "\\n"
          end if
          set tabIndex to tabIndex + 1
        end repeat
      end repeat
      return resultLines
    end tell
  `;

  return runOsascript(script).then((out) => {
    if (!out) return null;
    // Try exact match first
    const exact = matchTab(out, expectedTitle);
    if (exact) return exact;
    // Fall back to substring match (window name contains extra info)
    for (const line of out.trim().split("\n")) {
      const [numStr, ...rest] = line.split("\t");
      const title = rest.join("\t").trim();
      if (title && title.includes(expectedTitle)) {
        return {
          tabNumber: parseInt(numStr, 10),
          tabTitle: expectedTitle,
        };
      }
    }
    return null;
  });
}

/**
 * Detect the running terminal and find our tab by matching the pi title.
 * Supports Ghostty, iTerm2, and Terminal.app.
 */
function findOurTab(
  cwd: string
): Promise<{ tabNumber: number; tabTitle: string } | null> {
  const project = basename(cwd);
  const expectedTitle = `π - ${project}`;
  const term = process.env.TERM_PROGRAM ?? "";

  switch (term) {
    case "ghostty":
      return findGhosttyTab(expectedTitle);
    case "iTerm.app":
      return findITerm2Tab(expectedTitle);
    case "Apple_Terminal":
      return findTerminalAppTab(expectedTitle);
    default:
      // Unknown terminal — try Ghostty first (most common for pi users),
      // then fall back to iTerm2, then Terminal.app.
      return findGhosttyTab(expectedTitle)
        .then((r) => r ?? findITerm2Tab(expectedTitle))
        .then((r) => r ?? findTerminalAppTab(expectedTitle));
  }
}

export default function (pi: ExtensionAPI) {
  const appPath = resolveAppPath();

  if (!appPath) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(
        "macos-notify: PiNotify.app not found and auto-build failed. " +
          "Install Xcode Command Line Tools (xcode-select --install) and /reload, " +
          "or run macos-notify-app/build.sh manually.",
        "warning"
      );
    });
    return;
  }

  let agentStartTime: number | null = null;
  let tabMarked = false;

  pi.on("agent_start", async (_event, ctx) => {
    agentStartTime = Date.now();
    // Returning to the tab to submit a prompt means the user has seen it —
    // clear any attention cue set by the previous agent_end.
    if (tabMarked) {
      clearTabAttention(ctx.cwd);
      tabMarked = false;
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (agentStartTime === null) return;

    const elapsed = Date.now() - agentStartTime;
    agentStartTime = null;

    if (elapsed >= MIN_DURATION_MS) {
      const seconds = Math.round(elapsed / 1000);
      const tab = await findOurTab(ctx.cwd);
      const tabInfo = tab
        ? ` (${tab.tabTitle} · tab ${tab.tabNumber})`
        : "";
      sendNotification(appPath, "pi", `Done — ${seconds}s${tabInfo}`);

      // Draw attention to the tab (iTerm2 color / Ghostty title marker).
      tabMarked = markTabAttention(ctx.cwd);
    }
  });

  // Safety net: if the user quits (or reloads/switches sessions) without
  // submitting another prompt, agent_start never fires — so clear any
  // attention cue here to avoid leaving a stale color/title on the tab.
  pi.on("session_shutdown", async (_event, ctx) => {
    if (tabMarked) {
      clearTabAttention(ctx.cwd);
      tabMarked = false;
    }
  });
}
