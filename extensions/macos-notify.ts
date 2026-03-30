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

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const MIN_DURATION_MS = 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Try to build PiNotify.app from source using build.sh. */
function tryBuild(): string | null {
  const buildScript = join(__dirname, "..", "macos-notify-app", "build.sh");
  if (!existsSync(buildScript)) return null;

  try {
    execFileSync(buildScript, { stdio: "pipe", timeout: 30_000 });
    const built = join(__dirname, "..", "macos-notify-app", "PiNotify.app");
    return existsSync(built) ? built : null;
  } catch {
    return null;
  }
}

/** Resolve PiNotify.app, checking package-local build first, then ~/.pi/agent, then auto-building. */
function resolveAppPath(): string | null {
  const candidates = [
    join(__dirname, "..", "macos-notify-app", "PiNotify.app"),
    join(homedir(), ".pi", "agent", "PiNotify.app"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Not found — try building from source
  return tryBuild();
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

function sendNotification(
  appPath: string,
  title: string,
  body: string,
  sound = "Glass"
) {
  execFile("/usr/bin/open", [appPath, "--args", title, body, sound], (err) => {
    if (err) console.error("[macos-notify] error:", err.message);
  });
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

  pi.on("agent_start", async () => {
    agentStartTime = Date.now();
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
    }
  });
}
