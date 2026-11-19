/**
 * Review Extension
 *
 * Registers a `/review [model] [--base <ref>] [--cwd <path>]` command that
 * spawns a fresh, isolated `pi` process to critically review your recent
 * work. The reviewer runs in its own context (`--no-session`), with read-only
 * tools, and critiques the diff: bugs, security holes, missed edge cases,
 * untested paths, and anything that contradicts the stated intent.
 *
 * Working directory: a session often lives in the main clone while its work
 * happens on a branch in a separate worktree. So unless `--cwd <path>` is given,
 * /review first infers the worktree from this session's own transcript (the
 * files it edited/wrote, and any `git worktree add` / `cd` / `git -C` it ran).
 * Failing that, it scans the repo's worktrees and picks the one with work
 * (uncommitted changes or commits ahead of base): the current dir if it has
 * work, else the single other candidate, else a picker. When the chosen dir
 * isn't the session cwd — or the target falls back to committed history — it
 * confirms before running, so it can never silently review the wrong thing.
 *
 * Model precedence (highest first):
 *   1. `/review <model>` argument
 *   2. `model` in ~/.pi/agent/review.toml
 *   3. built-in default (gpt-6.1-sol)
 *
 * Review target (what gets diffed), in order:
 *   1. `--base <ref>`      — everything since the merge-base with <ref>
 *                             (committed + uncommitted), plus new files.
 *   2. `diff_command` set  — run it verbatim; its stdout is the review.
 *   3. uncommitted work    — `git diff HEAD` plus untracked files, if any.
 *   4. local-only commits — fallback when the tree is clean: the commits on
 *                             HEAD not reachable from any remote-tracking
 *                             branch. Already-pushed commits are never reviewed
 *                             (pointless); this still covers "commit, then
 *                             /review" as long as you haven't pushed yet.
 * If none of these produce a diff, /review reports that there is nothing to do.
 *
 * Configuration: ~/.pi/agent/review.toml (all keys optional)
 *   model              = "gpt-6.1-sol"   # reviewer model
 *   thinking           = "high"          # reviewer thinking level
 *   extra_instructions = "..."           # appended to the reviewer prompt
 *   feedback           = "discuss"       # discuss | auto | off
 *   include_untracked  = true            # include new/untracked files (default)
 *   diff_command       = ""              # advanced: full override of the target
 *
 * `feedback` controls what happens after the critique is produced:
 *   - "discuss" (default): inject it as a user message that tells the main agent
 *     to walk you through the findings WITHOUT editing anything, then wait for
 *     your go-ahead before changing code.
 *   - "auto": inject it and let the main agent fix the findings immediately.
 *   - "off": display the critique read-only; do not trigger a turn.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown } from "@earendil-works/pi-tui";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_MODEL = "gpt-6.1-sol";
const REVIEW_TOOLS = ["read", "grep", "find", "ls", "bash"];
const CUSTOM_TYPE = "adversarial-review";

// Caps so a huge or binary new file can't blow the reviewer's context window.
const MAX_UNTRACKED_FILE_BYTES = 256 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 512 * 1024;

// git's canonical empty-tree object, used as the base when the oldest local-only
// commit is the root commit (it has no parent to diff against).
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const SYSTEM_PROMPT = `You are a skeptical, senior code reviewer. A different agent produced the
changes shown in the user's diff, and you are the independent second pair of eyes. Be rigorous
and critical: your value is catching problems the author missed, not reassuring them. But stay
calibrated \u2014 do not inflate severity, do not invent issues to seem thorough, and do not pad
the review with a restatement of what the change does.

You have read-only tools. Use bash ONLY for read-only inspection (\`git diff\`, \`git log\`,
\`git show\`, \`cat\`, \`rg\`). NEVER modify files, stage, commit, or run builds/tests that mutate
state. Assume tool permissions are not perfectly enforced and keep every command strictly
read-only.

Strategy:
1. Read the provided diff carefully.
2. Open the surrounding files to understand context the diff does not show before judging intent.
3. Look hard for: real bugs, logic errors, race conditions, unhandled errors, resource leaks,
   security issues (injection, authz, secrets, unsafe deserialization), broken edge cases,
   off-by-ones, incorrect types/enums, behavior that contradicts the apparent intent, missing
   or wrong tests, and anything that will break existing callers.

Output format (omit a section if it is genuinely empty \u2014 do not invent issues to fill it):

## Critical (must fix)
- \`path:line\` \u2014 concrete problem and why it bites, with the failing scenario.

## Warnings (should fix)
- \`path:line\` \u2014 problem and why it matters.

## Suggestions (consider)
- \`path:line\` \u2014 improvement.

## Verdict
One or two blunt sentences: is this change safe to ship as-is, and if not, what is the single
biggest blocker? If the change genuinely looks sound, say so plainly rather than manufacturing
concerns.

Calibrate severity honestly: reserve Critical for things that actually break or are unsafe.
Always cite file and line. Prefer one well-explained real defect over ten vague nitpicks.`;

type FeedbackMode = "discuss" | "auto" | "off";

interface ReviewConfig {
  model: string;
  thinking?: string;
  diffCommand?: string;
  extraInstructions?: string;
  feedback: FeedbackMode;
  includeUntracked: boolean;
}

function configPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "review.toml");
}

/**
 * Minimal TOML-ish parser: `key = value` lines, `#` comments, quoted strings,
 * bare booleans/numbers. Section headers ([x]) and blank lines are ignored.
 */
function parseConfig(): Partial<Record<string, string | boolean>> {
  const out: Record<string, string | boolean> = {};
  let content: string;
  try {
    content = fs.readFileSync(configPath(), "utf-8");
  } catch {
    return out;
  }
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // strip trailing inline comment on unquoted values
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      out[key] = value.slice(1, -1);
    } else if (value === "true" || value === "false") {
      out[key] = value === "true";
    } else {
      out[key] = value;
    }
  }
  return out;
}

function loadConfig(modelArg: string): ReviewConfig {
  const cfg = parseConfig();
  const str = (k: string): string | undefined =>
    typeof cfg[k] === "string" && (cfg[k] as string).length > 0 ? (cfg[k] as string) : undefined;

  const model = modelArg.trim() || str("model") || DEFAULT_MODEL;
  const feedbackRaw = (str("feedback") || "discuss").toLowerCase();
  const feedback: FeedbackMode =
    feedbackRaw === "auto" || feedbackRaw === "off" ? feedbackRaw : "discuss";
  return {
    model,
    thinking: str("thinking"),
    diffCommand: str("diff_command"),
    extraInstructions: str("extra_instructions"),
    feedback,
    includeUntracked: cfg.include_untracked === false ? false : true,
  };
}

/** Split the raw argument string into a model token, an optional --base ref, and --cwd. */
function parseArgs(raw: string): { model: string; base?: string; cwd?: string } {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  let model = "";
  let base: string | undefined;
  let cwd: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--base" || t === "-b") {
      base = tokens[i + 1];
      i++;
    } else if (t.startsWith("--base=")) {
      base = t.slice("--base=".length);
    } else if (t === "--cwd" || t === "-C") {
      cwd = tokens[i + 1];
      i++;
    } else if (t.startsWith("--cwd=")) {
      cwd = t.slice("--cwd=".length);
    } else if (!model && !t.startsWith("-")) {
      model = t;
    }
  }
  return { model, base, cwd };
}

interface DiffTarget {
  text: string;
  label: string;
  /** True when no uncommitted work was found and we fell back to committed history. */
  fallback: boolean;
}

type GitRunner = (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;
type ShellRunner = (command: string) => Promise<{ stdout: string; stderr: string; code: number }>;
type GitFactory = (cwd: string) => GitRunner;

/** Expand a leading ~ and resolve relative to a base directory. */
function resolvePath(p: string, baseCwd: string): string {
  let expanded = p;
  if (expanded === "~") expanded = os.homedir();
  else if (expanded.startsWith("~/")) expanded = path.join(os.homedir(), expanded.slice(2));
  return path.resolve(baseCwd, expanded);
}

/** Shorten a path for display, collapsing $HOME to ~. */
function shortPath(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Normalize a path for prefix comparison by symlink-resolving its deepest
 * existing ancestor and re-appending the rest. This makes a worktree root and a
 * path under it compare equal even when the file no longer exists or the repo
 * lives under a symlinked dir (e.g. macOS /tmp -> /private/tmp).
 */
function normalizeForMatch(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

interface Worktree {
  path: string;
  branch: string;
}

/** Parse `git worktree list --porcelain` into {path, branch} entries. */
async function listWorktrees(gitRepo: GitRunner): Promise<Worktree[]> {
  const r = await gitRepo(["worktree", "list", "--porcelain"]);
  if (r.code !== 0) return [];
  const out: Worktree[] = [];
  let current: Partial<Worktree> = {};
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length).trim() };
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (line.startsWith("detached")) {
      current.branch = "(detached)";
    } else if (line.trim() === "" && current.path) {
      out.push({ path: current.path, branch: current.branch ?? "" });
      current = {};
    }
  }
  if (current.path) out.push({ path: current.path, branch: current.branch ?? "" });
  return out;
}

/**
 * Commits reachable from HEAD but not from any remote-tracking branch, oldest
 * first — i.e. local-only work that has not been pushed anywhere. Returns []
 * when the repo has no remote-tracking refs at all (nothing is "pushed" to
 * compare against, so we do not treat the whole history as reviewable).
 */
async function localOnlyCommits(git: GitRunner): Promise<string[]> {
  const remotes = await git(["for-each-ref", "--count=1", "--format=%(refname)", "refs/remotes"]);
  if (remotes.code !== 0 || !remotes.stdout.trim()) return [];
  const r = await git(["rev-list", "--reverse", "HEAD", "--not", "--remotes"]);
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A worktree is a review candidate if it has uncommitted changes or local-only commits. */
async function worktreeHasWork(git: GitRunner): Promise<boolean> {
  const status = await git(["status", "--porcelain"]);
  if (status.code === 0 && status.stdout.trim()) return true;
  return (await localOnlyCommits(git)).length > 0;
}

interface ChosenDir {
  cwd: string;
  /** True when we picked a directory other than where the session is. */
  switched: boolean;
  /** True when the user cancelled a multi-worktree selection. */
  cancelled?: boolean;
}

function sameDir(a: string, b: string): boolean {
  return realpathOrSelf(a) === realpathOrSelf(b);
}

/** Absolute paths this session actually operated on, oldest -> newest. */
function extractSessionPaths(entries: readonly unknown[]): string[] {
  const out: string[] = [];
  const pushAbs = (p: string | undefined) => {
    if (!p) return;
    let x = p.trim();
    if (!x) return;
    if (x === "~") x = os.homedir();
    else if (x.startsWith("~/")) x = path.join(os.homedir(), x.slice(2));
    if (x.startsWith("/")) out.push(x);
  };
  for (const e of entries as any[]) {
    if (e?.type !== "message") continue;
    const msg = e.message;
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b?.type !== "toolCall") continue;
      const name = b.name;
      const a = b.arguments ?? {};
      // edit/write are the strongest "work" signal (read is excluded: reading a
      // reference file elsewhere should not move the target).
      if ((name === "edit" || name === "write") && typeof a.path === "string") {
        pushAbs(a.path);
      } else if (name === "bash" && typeof a.command === "string") {
        const cmd: string = a.command;
        for (const m of cmd.matchAll(
          /git\s+worktree\s+add\s+(?:--?\S+\s+)*(['"]?)([~/][^\s'"]*)\1/g,
        ))
          pushAbs(m[2]);
        for (const m of cmd.matchAll(/(?:^|[;&|]\s*)cd\s+(['"]?)([~/][^\s'"]*)\1/g)) pushAbs(m[2]);
        for (const m of cmd.matchAll(/git\s+-C\s+(['"]?)([~/][^\s'"]*)\1/g)) pushAbs(m[2]);
      }
    }
  }
  return out;
}

/**
 * Infer, from this session's transcript, which worktree it was working in.
 * Returns the worktree root of the most recent path the session touched, or
 * null when nothing in the transcript points at a known worktree.
 */
function inferWorktree(entries: readonly unknown[], worktrees: Worktree[]): string | null {
  const roots = worktrees.map((w) => ({ raw: w.path, norm: normalizeForMatch(w.path) }));
  let match: string | null = null;
  for (const p of extractSessionPaths(entries)) {
    const norm = normalizeForMatch(p);
    for (const r of roots) {
      if (norm === r.norm || norm.startsWith(r.norm + path.sep)) {
        match = r.raw; // keep overwriting: the last match wins (most recent)
        break;
      }
    }
  }
  return match;
}

async function getWorktreeContext(
  gitFactory: GitFactory,
  originCwd: string,
): Promise<{ cwdRoot: string; worktrees: Worktree[] }> {
  const top = await gitFactory(originCwd)(["rev-parse", "--show-toplevel"]);
  const cwdRoot = top.code === 0 && top.stdout.trim() ? top.stdout.trim() : originCwd;
  const worktrees = await listWorktrees(gitFactory(cwdRoot));
  return { cwdRoot, worktrees };
}

/**
 * Choose which directory to review when no --cwd was given. First tries to
 * infer the worktree from this session's own transcript (what it edited / cd'd
 * into); failing that, scans worktrees for one with work and auto-picks the
 * sole candidate, prompting only when several qualify.
 */
async function autoResolveCwd(
  entries: readonly unknown[],
  gitFactory: GitFactory,
  originCwd: string,
  ui: { select: (title: string, items: string[]) => Promise<string | undefined> },
  hasUI: boolean,
): Promise<ChosenDir> {
  const { cwdRoot, worktrees } = await getWorktreeContext(gitFactory, originCwd);
  if (worktrees.length <= 1) return { cwd: cwdRoot, switched: false };

  // 1. infer from the session transcript (no prompt needed)
  const inferred = inferWorktree(entries, worktrees);
  if (inferred) return { cwd: inferred, switched: !sameDir(inferred, cwdRoot) };

  // 2. scan for worktrees that have work
  const candidates: Worktree[] = [];
  for (const wt of worktrees) {
    if (await worktreeHasWork(gitFactory(wt.path))) candidates.push(wt);
  }
  if (candidates.some((c) => sameDir(c.path, cwdRoot))) return { cwd: cwdRoot, switched: false };
  if (candidates.length === 0) return { cwd: cwdRoot, switched: false };
  if (candidates.length === 1) return { cwd: candidates[0].path, switched: true };

  if (!hasUI) return { cwd: cwdRoot, switched: false };
  const items = candidates.map((c) => `${shortPath(c.path)}${c.branch ? `  (${c.branch})` : ""}`);
  const picked = await ui.select("Review which worktree?", items);
  if (!picked) return { cwd: cwdRoot, switched: false, cancelled: true };
  const chosen = candidates[items.indexOf(picked)];
  return { cwd: chosen.path, switched: !sameDir(chosen.path, cwdRoot) };
}

/** Build a diff for untracked (new, non-ignored) files, with size caps. */
async function collectUntracked(
  git: GitRunner,
  cwd: string,
): Promise<{ text: string; count: number }> {
  const res = await git(["ls-files", "--others", "--exclude-standard", "-z"]);
  if (res.code !== 0) return { text: "", count: 0 };
  const files = res.stdout.split("\0").filter((f) => f.length > 0);
  const pieces: string[] = [];
  let total = 0;
  for (const f of files) {
    let size = 0;
    try {
      size = fs.statSync(path.join(cwd, f)).size;
    } catch {
      /* unreadable; let git try anyway */
    }
    if (size > MAX_UNTRACKED_FILE_BYTES) {
      pieces.push(`# New file (skipped, ${size} bytes): ${f}`);
      continue;
    }
    if (total > MAX_UNTRACKED_TOTAL_BYTES) {
      pieces.push(`# New file (skipped, untracked diff budget exceeded): ${f}`);
      continue;
    }
    // --no-index exits 1 when the files differ; that is expected, not an error.
    const d = await git(["diff", "--no-index", "--", "/dev/null", f]);
    if (d.stdout) {
      pieces.push(d.stdout);
      total += d.stdout.length;
    }
  }
  return { text: pieces.join("\n"), count: files.length };
}

/**
 * Resolve what to review. Returns null when there is genuinely nothing to do.
 * Order: explicit --base, then diff_command override, then uncommitted work
 * (tracked + untracked), then a fallback to unpushed commits.
 */
async function resolveTarget(
  git: GitRunner,
  sh: ShellRunner,
  cwd: string,
  cfg: ReviewConfig,
  base: string | undefined,
): Promise<DiffTarget | null> {
  // 1. explicit --base <ref>
  if (base) {
    const verify = await git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
    if (verify.code !== 0 || !verify.stdout.trim()) {
      throw new Error(`unknown git ref: ${base}`);
    }
    const mb = await git(["merge-base", base, "HEAD"]);
    const from = mb.code === 0 && mb.stdout.trim() ? mb.stdout.trim() : base;
    const d = await git(["diff", from]);
    const untracked = cfg.includeUntracked
      ? await collectUntracked(git, cwd)
      : { text: "", count: 0 };
    const text = [d.stdout, untracked.text].filter((s) => s.trim()).join("\n");
    if (!text.trim()) return null;
    const newNote = untracked.count > 0 ? ` + ${untracked.count} new file(s)` : "";
    const mbNote = mb.code === 0 ? " (merge-base)" : "";
    return { text, label: `work since ${base}${mbNote}${newNote}`, fallback: false };
  }

  // 2. diff_command override (power user owns the whole target)
  if (cfg.diffCommand) {
    const r = await sh(cfg.diffCommand);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `diff_command exited ${r.code}`);
    if (!r.stdout.trim()) return null;
    return { text: r.stdout, label: `custom diff_command: ${cfg.diffCommand}`, fallback: false };
  }

  // 3. uncommitted work (tracked edits + untracked new files)
  const tracked = await git(["diff", "HEAD"]);
  const untracked = cfg.includeUntracked
    ? await collectUntracked(git, cwd)
    : { text: "", count: 0 };
  if (tracked.stdout.trim() || untracked.count > 0) {
    const text = [tracked.stdout, untracked.text].filter((s) => s.trim()).join("\n");
    const parts: string[] = [];
    if (tracked.stdout.trim()) parts.push("tracked edits");
    if (untracked.count > 0) parts.push(`${untracked.count} new file(s)`);
    return { text, label: `uncommitted changes (${parts.join(", ")})`, fallback: false };
  }

  // 4. fallback: local-only commits (not reachable from any remote). Committed
  //    work that is already pushed is intentionally NOT reviewed — reviewing a
  //    commit that already exists on the remote is pointless.
  const localCommits = await localOnlyCommits(git);
  if (localCommits.length > 0) {
    const oldest = localCommits[0];
    const parent = await git(["rev-parse", "--verify", "--quiet", `${oldest}^`]);
    const from = parent.code === 0 && parent.stdout.trim() ? parent.stdout.trim() : EMPTY_TREE;
    const d = await git(["diff", from, "HEAD"]);
    if (d.stdout.trim()) {
      const n = localCommits.length;
      return {
        text: d.stdout,
        label: `${n} local-only commit${n === 1 ? "" : "s"} (not on any remote)`,
        fallback: true,
      };
    }
  }
  return null;
}

/**
 * Resolve how to re-invoke pi (adapted from the sample subagent extension):
 * prefer the current script under the active runtime, else a bare `pi`.
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

/** Run the reviewer subprocess; resolve with the final assistant text. */
async function runReviewer(
  cfg: ReviewConfig,
  diff: string,
  cwd: string,
  signal: AbortSignal | undefined,
  onTurn: (turns: number) => void,
): Promise<{ output: string; exitCode: number; stderr: string }> {
  const systemPrompt = cfg.extraInstructions
    ? `${SYSTEM_PROMPT}\n\n## Additional instructions for this project\n${cfg.extraInstructions}`
    : SYSTEM_PROMPT;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-"));
  const promptFile = path.join(tmpDir, "reviewer.md");
  fs.writeFileSync(promptFile, systemPrompt, { encoding: "utf-8", mode: 0o600 });

  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--model",
    cfg.model,
    "--tools",
    REVIEW_TOOLS.join(","),
    "--append-system-prompt",
    promptFile,
  ];
  if (cfg.thinking) args.push("--thinking", cfg.thinking);
  args.push(
    "The content on stdin is the work to review: a `# Review scope:` line" +
      " followed by the diff. Review it critically now.",
  );

  const invocation = getPiInvocation(args);

  try {
    return await new Promise((resolve) => {
      const proc = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let output = "";
      let stderr = "";
      let buffer = "";
      let turns = 0;

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.type === "message_end" && event.message?.role === "assistant") {
          const msg = event.message;
          const text = Array.isArray(msg.content)
            ? msg.content
                .filter((p: any) => p.type === "text")
                .map((p: any) => p.text)
                .join("")
            : "";
          if (text.trim()) output = text;
          turns++;
          onTurn(turns);
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve({ output: output.trim(), exitCode: code ?? 0, stderr });
      });
      proc.on("error", (err) => {
        resolve({ output: "", exitCode: 1, stderr: `${stderr}\n${err.message}`.trim() });
      });

      if (signal) {
        const kill = () => {
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) kill();
        else signal.addEventListener("abort", kill, { once: true });
      }

      // Feed the diff to the reviewer on stdin, prepended to its first prompt.
      proc.stdin.write(diff);
      proc.stdin.end();
    });
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export default function reviewExtension(pi: ExtensionAPI) {
  // Catalogue of models + cwd for /review argument completion, per session.
  let availableModels: string[] = [];
  let sessionCwd = process.cwd();
  const refreshContext = (ctx: any) => {
    if (typeof ctx?.cwd === "string" && ctx.cwd) sessionCwd = ctx.cwd;
    try {
      const models = ctx?.modelRegistry?.getAvailable?.() ?? [];
      availableModels = models
        .map((m: any) => (m.provider ? `${m.provider}/${m.id}` : m.id))
        .filter((s: unknown): s is string => typeof s === "string");
    } catch {
      /* leave previous list */
    }
  };
  pi.on("session_start", (_event, ctx) => refreshContext(ctx));

  // Local/remote branches and tags, for --base completion (sync; fast enough).
  const gitRefs = (): string[] => {
    try {
      const res = spawnSync(
        "git",
        ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes", "refs/tags"],
        { cwd: sessionCwd, encoding: "utf-8" },
      );
      if (res.status !== 0 || !res.stdout) return [];
      return res.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  };

  // Worktree paths for --cwd completion (sync).
  const gitWorktreePaths = (): string[] => {
    try {
      const res = spawnSync("git", ["worktree", "list", "--porcelain"], {
        cwd: sessionCwd,
        encoding: "utf-8",
      });
      if (res.status !== 0 || !res.stdout) return [];
      return res.stdout
        .split("\n")
        .filter((l) => l.startsWith("worktree "))
        .map((l) => l.slice("worktree ".length).trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  };

  // Read-only rendering for the review when feedback is "off".
  pi.registerMessageRenderer(CUSTOM_TYPE, (message, { outputPad }, theme) => {
    const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Markdown(String(message.content ?? ""), 0, 0, getMarkdownTheme()));
    return box;
  });

  pi.registerCommand("review", {
    description: "Critically review recent work in a fresh pi process",
    // The whole argument string is passed here and the chosen value replaces it
    // wholesale, so each completion value is the full "<model> --base <ref>".
    getArgumentCompletions: (argPrefix) => {
      const tokens = argPrefix.split(/\s+/);
      const last = tokens[tokens.length - 1] ?? "";
      const prev = tokens.length >= 2 ? tokens[tokens.length - 2] : "";
      const head = tokens.slice(0, -1).join(" ");
      const withHead = (completion: string) => (head ? `${head} ${completion}` : completion);
      const lc = last.toLowerCase();

      if (prev === "--base" || prev === "-b") {
        const refs = gitRefs()
          .filter((r) => r.toLowerCase().includes(lc))
          .slice(0, 50)
          .map((r) => ({ value: withHead(r), label: r }));
        return refs.length > 0 ? refs : null;
      }

      if (prev === "--cwd" || prev === "-C") {
        const paths = gitWorktreePaths()
          .filter((p) => p.toLowerCase().includes(lc) || shortPath(p).toLowerCase().includes(lc))
          .slice(0, 50)
          .map((p) => ({ value: withHead(p), label: shortPath(p) }));
        return paths.length > 0 ? paths : null;
      }

      const items: { value: string; label: string }[] = [];
      if (last.length > 0 && "--base".startsWith(lc)) {
        items.push({ value: withHead("--base "), label: "--base <ref>" });
      }
      if (last.length > 0 && "--cwd".startsWith(lc)) {
        items.push({ value: withHead("--cwd "), label: "--cwd <path>" });
      }
      for (const m of availableModels) {
        if (m.toLowerCase().includes(lc)) items.push({ value: withHead(m), label: m });
      }
      return items.length > 0 ? items.slice(0, 50) : null;
    },
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy \u2014 wait for it to finish, then run /review.", "warning");
        return;
      }
      refreshContext(ctx);
      const { model, base, cwd: cwdArg } = parseArgs(args);
      const cfg = loadConfig(model);
      const originCwd = ctx.cwd;
      const gitFactory: GitFactory = (dir) => (a) =>
        pi.exec("git", a, { cwd: dir, signal: ctx.signal });

      // Decide which directory to review: explicit --cwd, else auto-detect the
      // worktree that actually has the work (the session may sit elsewhere).
      let reviewCwd = originCwd;
      let switched = false;
      if (cwdArg) {
        reviewCwd = resolvePath(cwdArg, originCwd);
        switched = realpathOrSelf(reviewCwd) !== realpathOrSelf(originCwd);
      } else {
        ctx.ui.setStatus("review", "locating the worktree with the work\u2026");
        try {
          const chosen = await autoResolveCwd(
            ctx.sessionManager.getBranch(),
            gitFactory,
            originCwd,
            ctx.ui,
            ctx.hasUI,
          );
          if (chosen.cancelled) {
            ctx.ui.setStatus("review", "");
            ctx.ui.notify("Review cancelled.", "info");
            return;
          }
          reviewCwd = chosen.cwd;
          switched = chosen.switched;
        } catch {
          /* not a git repo or detection failed; fall back to the session cwd */
        }
      }

      const git: GitRunner = gitFactory(reviewCwd);
      const sh: ShellRunner = (c) => pi.exec("bash", ["-c", c], { cwd: reviewCwd, signal: ctx.signal });

      ctx.ui.setStatus("review", "resolving review target\u2026");
      let target: DiffTarget | null;
      try {
        target = await resolveTarget(git, sh, reviewCwd, cfg, base);
      } catch (err) {
        ctx.ui.setStatus("review", "");
        ctx.ui.notify(`Could not build a diff: ${(err as Error).message}`, "error");
        return;
      }
      if (!target) {
        ctx.ui.setStatus("review", "");
        ctx.ui.notify(
          `Nothing to review in ${shortPath(reviewCwd)} \u2014 no uncommitted changes, new files, or unpushed commits found.`,
          "info",
        );
        return;
      }

      // Pre-flight confirm when we switched directories or fell back to committed
      // history — the two cases where a wrong target could slip through silently.
      if ((switched || target.fallback) && ctx.hasUI) {
        ctx.ui.setStatus("review", "");
        const ok = await ctx.ui.confirm(
          "Critical review",
          `Review ${target.label}\nin ${shortPath(reviewCwd)}?`,
        );
        if (!ok) {
          ctx.ui.notify("Review cancelled.", "info");
          return;
        }
      }

      const scope = `${target.label} \u00b7 ${shortPath(reviewCwd)}`;
      const stdinText = `# Review scope: ${target.label} (in ${reviewCwd})\n\n${target.text}`;
      ctx.ui.setStatus("review", `reviewing ${target.label} with ${cfg.model}\u2026`);
      let result: { output: string; exitCode: number; stderr: string };
      try {
        result = await runReviewer(cfg, stdinText, reviewCwd, ctx.signal, (turns) => {
          ctx.ui.setStatus("review", `reviewing with ${cfg.model}\u2026 (turn ${turns})`);
        });
      } catch (err) {
        ctx.ui.setStatus("review", "");
        ctx.ui.notify(`Review failed: ${(err as Error).message}`, "error");
        return;
      }
      ctx.ui.setStatus("review", "");

      if (!result.output) {
        ctx.ui.notify(
          `Reviewer produced no output (exit ${result.exitCode}). ${
            result.stderr ? result.stderr.split("\n").slice(-3).join(" ") : ""
          }`.trim(),
          "error",
        );
        return;
      }

      const header = `## \uD83D\uDD0E Critical review \u2014 ${cfg.model}\n_Scope: ${scope}_`;
      if (cfg.feedback === "off") {
        pi.sendMessage(
          { customType: CUSTOM_TYPE, content: `${header}\n\n${result.output}`, display: true },
          { triggerTurn: false },
        );
        ctx.ui.notify('Review complete (read-only; set feedback="discuss" to talk it through).', "info");
      } else if (cfg.feedback === "auto") {
        pi.sendUserMessage(
          `${header}\n\n${result.output}\n\n---\nTriage each finding above: fix the real ones, and for anything you disagree with, say so and why. Do not just agree.`,
        );
      } else {
        // discuss (default): bring the review into the conversation but do NOT
        // let the agent start editing — talk it through first.
        pi.sendUserMessage(
          `${header}\n\n${result.output}\n\n---\nDo NOT edit any files or run any commands yet. Walk me through these findings: for each one, say whether you agree and why, and what you would change. Then wait for my go-ahead before making any changes.`,
        );
      }
    },
  });
}
