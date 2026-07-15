/**
 * GitHub PRs Extension
 *
 * Provides a /prs command that fetches your open pull requests from GitHub
 * and displays the title, the approval status of each reviewer, and an
 * overall approval indicator (✅ when at least one reviewer has approved).
 *
 * Usage: /prs
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Review {
  author: { login: string };
  state: string;
}

interface ReviewRequest {
  login?: string;
  name?: string;
}

interface PR {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  reviews: Review[];
  reviewRequests: ReviewRequest[];
}

// ANSI color helpers
const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

// OSC 8 terminal hyperlink
function link(url: string, text: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}


function colorize(text: string, ...codes: string[]): string {
  return `${codes.join("")}${text}${ansi.reset}`;
}

// White check mark shown when a PR has at least one approval
const APPROVAL_EMOJI = "✅";

function getReviewStatusIndicator(state: string): string {
  switch (state) {
    case "APPROVED":
      return colorize("✔", ansi.green, ansi.bold);
    case "CHANGES_REQUESTED":
      return colorize("✘", ansi.red, ansi.bold);
    case "COMMENTED":
      return colorize("●", ansi.yellow);
    case "DISMISSED":
      return colorize("○", ansi.gray);
    default:
      return colorize("?", ansi.gray);
  }
}

// Code points that render as two terminal cells (emoji presentation)
const WIDE_CODE_POINTS = new Set<number>([0x2705]); // ✅ white check mark

// Calculate display width, stripping ANSI escape sequences and OSC 8 hyperlinks
function displayWidth(str: string): number {
  const stripped = str
    .replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "") // strip OSC 8 hyperlinks
    .replace(/\x1b\[[0-9;]*m/g, ""); // strip ANSI colors
  let width = 0;
  for (const ch of stripped) {
    width += WIDE_CODE_POINTS.has(ch.codePointAt(0)!) ? 2 : 1;
  }
  return width;
}

function padDisplay(str: string, targetWidth: number): string {
  const w = displayWidth(str);
  return str + " ".repeat(Math.max(0, targetWidth - w));
}

// ANSI/OSC8-aware truncation. Counts only visible cells, passes escape
// sequences through untouched, and re-appends a reset if any color was open.
function truncateDisplay(str: string, maxWidth: number, ellipsis = "…"): string {
  if (displayWidth(str) <= maxWidth) return str;
  const target = Math.max(0, maxWidth - displayWidth(ellipsis));
  let width = 0;
  let out = "";
  let i = 0;
  let hadColor = false;
  while (i < str.length) {
    const rest = str.slice(i);
    const ansiMatch = rest.match(/^\x1b\[[0-9;]*m/);
    if (ansiMatch) {
      out += ansiMatch[0];
      hadColor = true;
      i += ansiMatch[0].length;
      continue;
    }
    const oscMatch = rest.match(/^\x1b\]8;;[^\x1b]*\x1b\\/);
    if (oscMatch) {
      out += oscMatch[0];
      i += oscMatch[0].length;
      continue;
    }
    const cp = str.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const w = WIDE_CODE_POINTS.has(cp) ? 2 : 1;
    if (width + w > target) break;
    out += ch;
    width += w;
    i += ch.length;
  }
  out += ellipsis;
  if (hadColor) out += ansi.reset;
  return out;
}

// Current pane/terminal width. Under a multiplexer (e.g. herdr) process.stdout
// is the pane's PTY, so this reflects the pane width, not the full terminal.
// This matches the width pi's TUI itself uses (ui.terminal.columns).
function terminalWidth(): number {
  return process.stdout.columns || Number(process.env.COLUMNS) || 80;
}

// notify() renders through a Text component with paddingX = 1, so it word-wraps
// content at (paneWidth - 2). Reserve that padding plus a 1-column safety margin
// so full-width table rows never wrap (which would shatter the box borders).
const MESSAGE_MARGIN = 3;

function getLatestReviews(reviews: Review[]): Map<string, string> {
  const latest = new Map<string, string>();
  // reviews are in chronological order, so last one per author wins
  for (const review of reviews) {
    latest.set(review.author.login, review.state);
  }
  return latest;
}

export default function githubPrsExtension(pi: ExtensionAPI) {
  pi.registerCommand("prs", {
    description: "Show your open GitHub PRs with reviewer approval status",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Fetching open PRs...", "info");


      try {
        const [prResult, userResult] = await Promise.all([
          pi.exec("gh", [
            "pr",
            "list",
            "--author",
            "@me",
            "--state",
            "open",
            "--json",
            "number,title,url,headRefName,reviews,reviewRequests",
          ]),
          pi.exec("gh", ["api", "user", "--jq", ".login"]),
        ]);

        const result = prResult;

        ctx.ui.setStatus("prs", "");

        if (result.code !== 0) {
          ctx.ui.notify(
            `Failed to fetch PRs: ${result.stderr || "unknown error"}`,
            "error"
          );
          return;
        }

        const prs: PR[] = JSON.parse(result.stdout);
        const currentUser = userResult.code === 0 ? userResult.stdout.trim() : "";
        prs.sort((a, b) => a.number - b.number);

        if (prs.length === 0) {
          ctx.ui.notify("No open PRs found.", "info");
          return;
        }

        // Build row data
        const rows: Array<{ pr: string; title: string; reviewers: string; status: string }> = [];

        for (const pr of prs) {
          const latestReviews = getLatestReviews(pr.reviews);
          latestReviews.delete(currentUser);
          const pendingReviewers = pr.reviewRequests
            .map((r) => r.login || r.name || "unknown")
            .filter((login) => !latestReviews.has(login) && login !== currentUser);

          const reviewerParts: Array<{ login: string; display: string }> = [];
          for (const [login, state] of latestReviews) {
            reviewerParts.push({ login, display: `${getReviewStatusIndicator(state)} ${login}` });
          }
          for (const login of pendingReviewers) {
            reviewerParts.push({ login, display: `${colorize("◌", ansi.dim)} ${colorize(login, ansi.dim)}` });
          }
          reviewerParts.sort((a, b) => a.login.localeCompare(b.login));

          const hasApproval = [...latestReviews.values()].some((state) => state === "APPROVED");

          rows.push({
            pr: link(pr.url, colorize(`#${pr.number}`, ansi.cyan)),
            title: colorize(pr.title, ansi.bold, ansi.white),
            reviewers: reviewerParts.length > 0 ? reviewerParts.map((r) => r.display).join("  ") : colorize("—", ansi.dim),
            status: hasApproval ? APPROVAL_EMOJI : "",
          });
        }

        // Column widths
        const colPr = Math.max(...rows.map((r) => displayWidth(r.pr)));
        const colStatus = Math.max(displayWidth(APPROVAL_EMOJI), ...rows.map((r) => displayWidth(r.status)));

        // Natural content width (widest title/reviewer line).
        const naturalContent = Math.max(
          ...rows.map((r) => displayWidth(r.title)),
          ...rows.map((r) => displayWidth(r.reviewers))
        );

        // Clamp the content column so the whole table fits the usable width.
        // Fixed overhead per row: 4 vertical bars + 6 padding spaces + the
        // fixed-width PR and status columns. The usable width is the pane width
        // minus the notify Text component's padding (MESSAGE_MARGIN).
        const usableWidth = terminalWidth() - MESSAGE_MARGIN;
        const fixedOverhead = 4 + 6 + colPr + colStatus;
        const availableContent = Math.max(10, usableWidth - fixedOverhead);
        const colContent = Math.min(naturalContent, availableContent);

        // Truncate any cells that exceed the (possibly clamped) content width.
        for (const r of rows) {
          r.title = truncateDisplay(r.title, colContent);
          r.reviewers = truncateDisplay(r.reviewers, colContent);
        }

        const h = (n: number) => colorize("─".repeat(n), ansi.gray);
        const v = colorize("│", ansi.gray);
        const lines: string[] = [""];

        lines.push(`${colorize("┌─", ansi.gray)}${h(colPr)}${colorize("─┬─", ansi.gray)}${h(colContent)}${colorize("─┬─", ansi.gray)}${h(colStatus)}${colorize("─┐", ansi.gray)}`);

        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          lines.push(`${v} ${padDisplay(r.pr, colPr)} ${v} ${padDisplay(r.title, colContent)} ${v} ${padDisplay(r.status, colStatus)} ${v}`);
          lines.push(`${v} ${padDisplay("", colPr)} ${v} ${padDisplay(r.reviewers, colContent)} ${v} ${padDisplay("", colStatus)} ${v}`);
          if (i < rows.length - 1) {
            lines.push(`${colorize("├─", ansi.gray)}${h(colPr)}${colorize("─┼─", ansi.gray)}${h(colContent)}${colorize("─┼─", ansi.gray)}${h(colStatus)}${colorize("─┤", ansi.gray)}`);
          }
        }

        lines.push(`${colorize("└─", ansi.gray)}${h(colPr)}${colorize("─┴─", ansi.gray)}${h(colContent)}${colorize("─┴─", ansi.gray)}${h(colStatus)}${colorize("─┘", ansi.gray)}`);
        lines.push("");

        ctx.ui.notify(lines.join("\n"), "info");
      } catch (err: unknown) {
        ctx.ui.setStatus("prs", "");
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Error: ${message}`, "error");
      }
    },
  });
}
