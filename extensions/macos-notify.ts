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
 *   - Includes Ghostty tab name & number in the notification
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

/** Query Ghostty tabs via AppleScript and find ours by matching the title. */
function findOurTab(
  cwd: string
): Promise<{ tabNumber: number; tabTitle: string } | null> {
  const project = basename(cwd);
  const expectedTitle = `π - ${project}`;

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
        for (const line of stdout.trim().split("\n")) {
          const [numStr, title] = line.split("\t");
          if (title && title.trim() === expectedTitle) {
            resolve({
              tabNumber: parseInt(numStr, 10),
              tabTitle: title.trim(),
            });
            return;
          }
        }
        resolve(null);
      }
    );
  });
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
