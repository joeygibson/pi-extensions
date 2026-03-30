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

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const DEBUG = false; // Set to true for verbose logging

type Action = "prompt" | "block";

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

          if (action !== "prompt" && action !== "block") {
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

function findMatchingRule(
  text: string,
  rules: SecurityRule[]
): SecurityRule | null {
  for (const rule of rules) {
    if (matchesPattern(text, rule)) {
      return rule;
    }
  }
  return null;
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

export default function (pi: ExtensionAPI) {
  ensureExampleConfig();

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

          const choice = await ctx.ui.select(
            `⚠️ Security check: Command contains "${matchedRule.pattern}"\n\nCommand: ${command}\n\nAllow?`,
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

          const choice = await ctx.ui.select(
            `⚠️ Security check: Writing to file matching "${matchedRule.pattern}"\n\nPath: ${filePath}\n\nAllow?`,
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

          const choice = await ctx.ui.select(
            `⚠️ Security check: Reading file matching "${matchedRule.pattern}"\n\nPath: ${filePath}\n\nAllow?`,
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
