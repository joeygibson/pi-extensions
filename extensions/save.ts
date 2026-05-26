/**
 * Save Extension
 *
 * Registers a `/save` command that writes the last assistant message
 * as markdown to a file. Accepts an optional filepath argument.
 * If no argument is given, generates a filename based on context.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, extname } from "node:path";

/**
 * Generate a slug from text content for use as a filename.
 * Takes the first ~6 meaningful words and kebab-cases them.
 */
function slugify(text: string): string {
  const words = text
    .replace(/[#*`_~\[\]()>]/g, "") // strip common markdown chars
    .replace(/\n+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 6)
    .map((w) => w.toLowerCase().replace(/[^a-z0-9-]/g, ""))
    .filter((w) => w.length > 0);

  if (words.length === 0) {
    return "output";
  }

  return words.join("-");
}

/**
 * Generate a filename from the last assistant message content.
 * Format: <slug>-<short-timestamp>.md
 */
function generateFilename(text: string): string {
  const slug = slugify(text);
  const now = new Date();
  const ts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
  ].join("");

  return `${slug}-${ts}.md`;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("save", {
    description: "Save the last assistant message as markdown to a file",
    handler: async (args, ctx) => {
      const entries = ctx.sessionManager.getBranch();

      // Walk backwards to find the last assistant message
      let markdown = "";
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
            ctx.ui.notify("Last assistant message had no text content.", "warning");
            return;
          }

          markdown = textParts.join("\n\n");
          break;
        }
      }

      if (!markdown) {
        ctx.ui.notify("No assistant message found.", "warning");
        return;
      }

      // Determine output path
      let filepath: string;
      if (args && args.trim().length > 0) {
        filepath = args.trim();
        // Add .md extension if none provided
        if (!extname(filepath)) {
          filepath += ".md";
        }
      } else {
        filepath = generateFilename(markdown);
      }

      // Resolve relative to cwd
      const absolutePath = resolve(ctx.cwd, filepath);

      // Ensure parent directory exists
      await mkdir(dirname(absolutePath), { recursive: true });

      // Write the file
      await writeFile(absolutePath, markdown + "\n", "utf8");

      ctx.ui.notify(`Saved to ${filepath}`, "info");
    },
  });
}
