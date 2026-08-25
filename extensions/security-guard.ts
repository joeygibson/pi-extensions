/**
 * Security Guard Extension
 *
 * Protects against destructive operations, sensitive file writes, and reads
 * through a configurable TOML-like configuration file.
 *
 * Configuration: ~/.pi/agent/security-guard.toml
 * An example config is written to ~/.pi/agent/security-guard.toml.example
 * on first load if it doesn't already exist.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveAppPath, sendNotification } from "../lib/pi-notify.ts";

/** Native notification sound + repeat interval for approval prompts. */
const APPROVAL_SOUND = "Submarine";
const NUDGE_INTERVAL_MS = 30_000;

const DEBUG = false; // Set to true for verbose logging

type Action = "prompt" | "block" | "allow";

interface SecurityRule {
  pattern: string;
  action: Action;
}

interface SecurityRules {
  operations: SecurityRule[];
  writes: SecurityRule[];
  reads: SecurityRule[];
}

const DEFAULT_RULES: SecurityRules = {
  operations: [
    { pattern: "rm -rf", action: "prompt" },
    { pattern: "sudo", action: "prompt" },
  ],
  writes: [
    { pattern: ".env", action: "block" },
    { pattern: "~/.ssh", action: "block" },
  ],
  reads: [
    { pattern: "~/.ssh", action: "block" },
    { pattern: "~/.aws/credentials", action: "prompt" },
  ],
};

function getConfigPath(): string {
  const piDir =
    process.env.PI_CODING_AGENT_DIR ||
    path.join(os.homedir(), ".pi", "agent");
  return path.join(piDir, "security-guard.toml");
}

function parseConfigFile(filePath: string): SecurityRules | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    const rules: SecurityRules = {
      operations: [],
      writes: [],
      reads: [],
    };

    let currentSection: "operations" | "writes" | "reads" | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Skip empty lines and comments
      if (line === "" || line.startsWith("#")) {
        continue;
      }

      // Check for section headers
      if (line === "[operations]") {
        currentSection = "operations";
        continue;
      } else if (line === "[writes]") {
        currentSection = "writes";
        continue;
      } else if (line === "[reads]") {
        currentSection = "reads";
        continue;
      }

      // Parse rule line: pattern = action
      // Split on last '=' to handle patterns containing '=' characters
      if (currentSection) {
        const lastEqualIndex = line.lastIndexOf("=");
        if (lastEqualIndex > 0) {
          const pattern = line.substring(0, lastEqualIndex).trim();
          const action = line.substring(lastEqualIndex + 1).trim() as Action;

          if (action !== "prompt" && action !== "block" && action !== "allow") {
            console.warn(
              `[security-guard] Invalid action "${action}" on line ${i + 1}, skipping`
            );
            continue;
          }

          rules[currentSection].push({ pattern, action });
        } else {
          console.warn(
            `[security-guard] Could not parse line ${i + 1}: ${line}`
          );
        }
      }
    }

    return rules;
  } catch (error) {
    console.error("[security-guard] Error reading config file:", error);
    return null;
  }
}

function loadRules(): SecurityRules {
  const configPath = getConfigPath();
  const parsed = parseConfigFile(configPath);

  if (parsed) {
    // Merge with defaults for any missing sections
    return {
      operations:
        parsed.operations.length > 0
          ? parsed.operations
          : DEFAULT_RULES.operations,
      writes:
        parsed.writes.length > 0 ? parsed.writes : DEFAULT_RULES.writes,
      reads: parsed.reads.length > 0 ? parsed.reads : DEFAULT_RULES.reads,
    };
  }

  return DEFAULT_RULES;
}

function expandTilde(pattern: string): string {
  if (pattern.startsWith("~/")) {
    return path.join(os.homedir(), pattern.slice(2));
  }
  return pattern;
}

function matchesPattern(text: string, rule: SecurityRule): boolean {
  if (text.includes(rule.pattern)) {
    return true;
  }

  // If pattern starts with ~, also check expanded version
  if (rule.pattern.startsWith("~")) {
    const expanded = expandTilde(rule.pattern);
    if (text.includes(expanded)) {
      return true;
    }
  }

  return false;
}

/**
 * Highlights the matched pattern so it's easy to spot (e.g. a nested "rm -rf")
 * in a long command. Checks both the literal pattern and, for ~ paths, the
 * expanded home path.
 *
 * If a `colorize` function is provided (e.g. ctx.ui.theme.fg bound to a color),
 * the *entire command segment* containing the match is colored — not just the
 * trigger pattern — so the command and its arguments stand out. Segments are
 * split on shell separators (&&, ||, |, ;, newline) so neighboring commands
 * stay uncolored. The whole colored segment is wrapped in »« markers so the
 * command and its arguments are clearly delimited even without color. Each
 * colored span is inline (no newlines), so per-line SGR resets in the TUI
 * won't bleed across lines.
 */
function highlightMatch(
  text: string,
  rule: SecurityRule,
  colorize?: (s: string) => string
): string {
  const needles = [rule.pattern];
  if (rule.pattern.startsWith("~")) {
    needles.push(expandTilde(rule.pattern));
  }

  // Highlight the longest matching needle present in the text.
  const needle = needles
    .filter((n) => n.length > 0 && text.includes(n))
    .sort((a, b) => b.length - a.length)[0];

  if (!needle) {
    return text;
  }

  const mark = (s: string) => s.split(needle).join(`»${needle}«`);

  // Without color, just mark the trigger pattern.
  if (!colorize) {
    return mark(text);
  }

  // With color, split into command segments (keeping separators) and color
  // any whole segment that contains the trigger, wrapping the command and its
  // arguments in »« markers (placed inside any surrounding whitespace).
  const separators = new Set(["&&", "||", "|", ";", "\n"]);
  const parts = text.split(/(&&|\|\||;|\||\n)/);

  return parts
    .map((part) => {
      if (separators.has(part) || !part.includes(needle)) {
        return part;
      }
      const m = part.match(/^(\s*)([\s\S]*?)(\s*)$/);
      const [, lead, core, trail] = m ?? ["", "", part, ""];
      return `${lead}${colorize(`»${core}«`)}${trail}`;
    })
    .join("");
}

function findMatchingRule(
  text: string,
  rules: SecurityRule[]
): SecurityRule | null {
  // Collect all matching rules and return the most specific one
  // (longest pattern). This allows narrow "allow" exceptions to
  // override broader "block" rules, e.g.:
  //   > /dev/ = block
  //   > /dev/null = allow
  let best: SecurityRule | null = null;
  for (const rule of rules) {
    if (matchesPattern(text, rule)) {
      if (best === null || rule.pattern.length > best.pattern.length) {
        best = rule;
      }
    }
  }
  return best;
}

function ensureExampleConfig() {
  const piDir =
    process.env.PI_CODING_AGENT_DIR ||
    path.join(os.homedir(), ".pi", "agent");
  const examplePath = path.join(piDir, "security-guard.toml.example");

  if (!fs.existsSync(examplePath)) {
    const exampleContent = `# Security Guard Configuration
#
# This extension protects against destructive operations, sensitive file writes,
# and sensitive file reads. Each rule has a pattern and an action.
#
# Actions:
#   prompt - Ask for user confirmation before allowing the operation
#   block  - Immediately block the operation without prompting
#   allow  - Explicitly allow (use to create exceptions to broader rules)
#
# Patterns use simple substring matching. For paths starting with ~/, both the
# literal pattern and the expanded home directory path are checked.
#
# Copy this file to security-guard.toml and customize for your needs.

[operations]
# Bash commands to guard against
rm -rf = prompt
sudo = prompt
dd if= = block
mkfs = block
> /dev/ = block
> /dev/null = allow

[writes]
# File paths to protect from write/edit operations
.env = block
~/.ssh = block
~/.aws = block
/etc/ = block
~/.bash_history = prompt

[reads]
# File paths to protect from read operations
~/.ssh = block
~/.aws/credentials = prompt
~/.gnupg = block
`;

    try {
      fs.writeFileSync(examplePath, exampleContent, "utf-8");
    } catch (error) {
      console.error(
        "[security-guard] Failed to create example config:",
        error
      );
    }
  }
}

/**
 * Show an approval prompt while nudging the user with a native macOS
 * notification (Submarine sound) immediately and then every
 * NUDGE_INTERVAL_MS until they respond. This covers the "walked away and pi
 * is silently blocked waiting on approval" case — the repeating toast/sound
 * pulls the user back, distinct from the one-shot "Done" notification.
 *
 * Degrades gracefully: if appPath is null (PiNotify.app unavailable) the
 * prompt still shows, just without the native nudge.
 */
async function selectWithNudge(
  ctx: { ui: { select: (message: string, options: string[]) => Promise<string> } },
  appPath: string | null,
  notifyBody: string,
  message: string,
  options: string[]
): Promise<string> {
  const alert = () => {
    if (appPath) {
      sendNotification(appPath, "pi — approval needed", notifyBody, APPROVAL_SOUND);
    }
  };

  alert();
  const timer = setInterval(alert, NUDGE_INTERVAL_MS);
  try {
    return await ctx.ui.select(message, options);
  } finally {
    clearInterval(timer);
  }
}

export default function (pi: ExtensionAPI) {
  ensureExampleConfig();

  // Resolve PiNotify.app once so approval prompts can nudge the user with a
  // native macOS notification (see selectWithNudge). May be null if the app
  // isn't built yet / build fails — the nudge then degrades to no toast.
  const appPath = resolveAppPath();

  // Rules are loaded on initialization. When /reload is called,
  // pi re-initializes this extension, which loads fresh rules.
  const rules = loadRules();

  pi.on("session_start", async (_event, ctx) => {
    const configPath = getConfigPath();
    const configExists = fs.existsSync(configPath);

    if (configExists) {
      const opCount = rules.operations.length;
      const writeCount = rules.writes.length;
      const readCount = rules.reads.length;
      ctx.ui.notify(
        `Security guard loaded: ${opCount} operations, ${writeCount} writes, ${readCount} reads`,
        "info"
      );
    } else {
      ctx.ui.notify(
        "Security guard using defaults (no config file found)",
        "info"
      );
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    // Handle bash commands
    if (event.toolName === "bash") {
      const command = event.input.command as string;
      const matchedRule = findMatchingRule(command, rules.operations);

      if (matchedRule) {
        if (DEBUG) {
          console.log(
            `[security-guard] Matched bash command: "${command}" -> ${matchedRule.action}`
          );
        }

        if (matchedRule.action === "allow") {
          return undefined;
        }

        if (matchedRule.action === "block") {
          if (ctx.hasUI) {
            ctx.ui.notify(
              `Blocked: bash command contains "${matchedRule.pattern}"`,
              "warning"
            );
          }
          return {
            block: true,
            reason: `Blocked by security-guard: pattern "${matchedRule.pattern}"`,
          };
        }

        if (matchedRule.action === "prompt") {
          if (!ctx.hasUI) {
            return {
              block: true,
              reason:
                "Security check required but no UI available for confirmation",
            };
          }

          const choice = await selectWithNudge(
            ctx,
            appPath,
            command,
            `⚠️ Security check: Command contains "${matchedRule.pattern}"\n\nCommand: ${highlightMatch(command, matchedRule, (s) => ctx.ui.theme.fg("error", s))}\n\nAllow?`,
            ["Allow", "Deny"]
          );

          if (choice !== "Allow") {
            ctx.ui.notify(`Denied: bash command "${command}"`, "warning");
            return { block: true, reason: "Denied by user" };
          }
        }
      }
    }

    // Handle write and edit operations
    if (event.toolName === "write" || event.toolName === "edit") {
      const filePath = event.input.path as string;
      const matchedRule = findMatchingRule(filePath, rules.writes);

      if (matchedRule) {
        if (DEBUG) {
          console.log(
            `[security-guard] Matched write path: "${filePath}" -> ${matchedRule.action}`
          );
        }

        if (matchedRule.action === "allow") {
          return undefined;
        }

        if (matchedRule.action === "block") {
          if (ctx.hasUI) {
            ctx.ui.notify(
              `Blocked: write to "${filePath}" (pattern: ${matchedRule.pattern})`,
              "warning"
            );
          }
          return {
            block: true,
            reason: `Blocked by security-guard: pattern "${matchedRule.pattern}"`,
          };
        }

        if (matchedRule.action === "prompt") {
          if (!ctx.hasUI) {
            return {
              block: true,
              reason:
                "Security check required but no UI available for confirmation",
            };
          }

          const choice = await selectWithNudge(
            ctx,
            appPath,
            `Write ${filePath}`,
            `⚠️ Security check: Writing to file matching "${matchedRule.pattern}"\n\nPath: ${highlightMatch(filePath, matchedRule, (s) => ctx.ui.theme.fg("error", s))}\n\nAllow?`,
            ["Allow", "Deny"]
          );

          if (choice !== "Allow") {
            ctx.ui.notify(`Denied: write to "${filePath}"`, "warning");
            return { block: true, reason: "Denied by user" };
          }
        }
      }
    }

    // Handle read operations
    if (event.toolName === "read") {
      const filePath = event.input.path as string;
      const matchedRule = findMatchingRule(filePath, rules.reads);

      if (matchedRule) {
        if (DEBUG) {
          console.log(
            `[security-guard] Matched read path: "${filePath}" -> ${matchedRule.action}`
          );
        }

        if (matchedRule.action === "allow") {
          return undefined;
        }

        if (matchedRule.action === "block") {
          if (ctx.hasUI) {
            ctx.ui.notify(
              `Blocked: read from "${filePath}" (pattern: ${matchedRule.pattern})`,
              "warning"
            );
          }
          return {
            block: true,
            reason: `Blocked by security-guard: pattern "${matchedRule.pattern}"`,
          };
        }

        if (matchedRule.action === "prompt") {
          if (!ctx.hasUI) {
            return {
              block: true,
              reason:
                "Security check required but no UI available for confirmation",
            };
          }

          const choice = await selectWithNudge(
            ctx,
            appPath,
            `Read ${filePath}`,
            `⚠️ Security check: Reading file matching "${matchedRule.pattern}"\n\nPath: ${highlightMatch(filePath, matchedRule, (s) => ctx.ui.theme.fg("error", s))}\n\nAllow?`,
            ["Allow", "Deny"]
          );

          if (choice !== "Allow") {
            ctx.ui.notify(`Denied: read from "${filePath}"`, "warning");
            return { block: true, reason: "Denied by user" };
          }
        }
      }
    }

    return undefined;
  });
}
