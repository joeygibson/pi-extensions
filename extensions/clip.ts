/**
 * Clipboard Extension
 *
 * Registers a `/clip` command that copies the last assistant message
 * (as markdown) to the macOS clipboard. No LLM round-trip needed.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import { platform } from "node:os";

function getClipboardCommand(): { cmd: string; args: string[] } {
  switch (platform()) {
    case "darwin":
      return { cmd: "pbcopy", args: [] };
    case "win32":
      return { cmd: "clip.exe", args: [] };
    case "linux":
      if (process.env.WAYLAND_DISPLAY) {
        return { cmd: "wl-copy", args: [] };
      }
      return { cmd: "xclip", args: ["-selection", "clipboard"] };
    default:
      throw new Error(`Unsupported platform: ${platform()}`);
  }
}

function copyToClipboard(text: string): Promise<void> {
  const { cmd, args } = getClipboardCommand();
  return new Promise((resolve, reject) => {
    const proc = execFile(cmd, args, (err) => {
      if (err) reject(err);
      else resolve();
    });
    proc.stdin?.write(text);
    proc.stdin?.end();
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("clip", {
    description: "Copy the last assistant message as markdown to clipboard",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getBranch();

      // Walk backwards to find the last assistant message
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          Array.isArray(entry.message.content)
        ) {
          const textParts = entry.message.content
            .filter((block: any) => block.type === "text")
            .map((block: any) => block.text);

          if (textParts.length === 0) {
            ctx.ui.notify("Last assistant message had no text content.", "warn");
            return;
          }

          const markdown = textParts.join("\n\n");
          await copyToClipboard(markdown);
          ctx.ui.notify("Copied to clipboard!", "success");
          return;
        }
      }

      ctx.ui.notify("No assistant message found.", "warn");
    },
  });
}
