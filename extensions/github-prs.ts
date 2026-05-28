/**
 * GitHub PRs Extension
 *
 * Provides a /prs command that fetches your open pull requests from GitHub
 * and displays the title and approval status of each reviewer.
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

// Calculate display width, stripping ANSI escape sequences and OSC 8 hyperlinks
function displayWidth(str: string): number {
  const stripped = str
    .replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "") // strip OSC 8 hyperlinks
    .replace(/\x1b\[[0-9;]*m/g, ""); // strip ANSI colors
  return stripped.length;
}

function padDisplay(str: string, targetWidth: number): string {
  const w = displayWidth(str);
  return str + " ".repeat(Math.max(0, targetWidth - w));
}

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
        const rows: Array<{ pr: string; title: string; reviewers: string }> = [];

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

          rows.push({
            pr: link(pr.url, colorize(`#${pr.number}`, ansi.cyan)),
            title: colorize(pr.title, ansi.bold, ansi.white),
            reviewers: reviewerParts.length > 0 ? reviewerParts.map((r) => r.display).join("  ") : colorize("—", ansi.dim),
          });
        }

        // Column widths
        const colPr = Math.max(...rows.map((r) => displayWidth(r.pr)));
        const colContent = Math.max(
          ...rows.map((r) => displayWidth(r.title)),
          ...rows.map((r) => displayWidth(r.reviewers))
        );

        const h = (n: number) => colorize("─".repeat(n), ansi.gray);
        const v = colorize("│", ansi.gray);
        const lines: string[] = [""];

        lines.push(`${colorize("┌─", ansi.gray)}${h(colPr)}${colorize("─┬─", ansi.gray)}${h(colContent)}${colorize("─┐", ansi.gray)}`);

        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          lines.push(`${v} ${padDisplay(r.pr, colPr)} ${v} ${padDisplay(r.title, colContent)} ${v}`);
          lines.push(`${v} ${padDisplay("", colPr)} ${v} ${padDisplay(r.reviewers, colContent)} ${v}`);
          if (i < rows.length - 1) {
            lines.push(`${colorize("├─", ansi.gray)}${h(colPr)}${colorize("─┼─", ansi.gray)}${h(colContent)}${colorize("─┤", ansi.gray)}`);
          }
        }

        lines.push(`${colorize("└─", ansi.gray)}${h(colPr)}${colorize("─┴─", ansi.gray)}${h(colContent)}${colorize("─┘", ansi.gray)}`);
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
