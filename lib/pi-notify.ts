/**
 * Shared macOS notification helper (PiNotify.app).
 *
 * Extracted so multiple extensions (macos-notify, security-guard) can send
 * native notifications through the same pre-built PiNotify.app bundle, which
 * lets macOS display the pi logo. See macos-notify-app/ for the source.
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

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
export function resolveAppPath(): string | null {
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

/** Send a native macOS notification via PiNotify.app. */
export function sendNotification(
  appPath: string,
  title: string,
  body: string,
  sound = "Glass"
) {
  // Keep the body to a sensible length — notifications truncate anyway, and
  // long bash commands make for an unwieldy toast.
  const trimmed = body.length > 140 ? `${body.slice(0, 139)}\u2026` : body;
  execFile("/usr/bin/open", [appPath, "--args", title, trimmed, sound], (err) => {
    if (err) console.error("[pi-notify] error:", err.message);
  });
}
