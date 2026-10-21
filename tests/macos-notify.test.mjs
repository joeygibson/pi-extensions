import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import macosNotify from "../extensions/macos-notify.ts";

const terminalEnv = ["TERM_PROGRAM", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_SESSION"];

async function finishTurn(t, env, { running = true, failLookup = false, duration = 4000 } = {}) {
  const previous = Object.fromEntries(terminalEnv.map(key => [key, process.env[key]]));
  const scripts = [];
  const notifications = [];
  const ttyWrites = [];
  const originalExists = fs.existsSync;
  const originalOpen = fs.openSync;
  const originalWrite = fs.writeSync;
  const originalClose = fs.closeSync;
  const tty = 98765;
  let now = 1000;
  try {
    for (const key of terminalEnv) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    t.mock.method(fs, "existsSync", path => String(path).endsWith("PiNotify.app") || originalExists(path));
    t.mock.method(fs, "openSync", (path, ...args) => path === "/dev/tty" ? tty : originalOpen(path, ...args));
    t.mock.method(fs, "writeSync", (fd, ...args) => {
      if (fd !== tty) return originalWrite(fd, ...args);
      ttyWrites.push(args[0]);
      return String(args[0]).length;
    });
    t.mock.method(fs, "closeSync", fd => fd === tty ? undefined : originalClose(fd));
    t.mock.method(childProcess, "execFileSync", () => assert.fail("No app builds or synchronous processes in tests"));
    t.mock.method(childProcess, "execFile", (file, args, options, callback) => {
      const done = typeof options === "function" ? options : callback;
      if (file === "/usr/bin/osascript") {
        scripts.push(args[1]);
        done(failLookup ? new Error("synthetic lookup failure") : null, running ? "1\tπ - project\n" : "");
      } else {
        assert.equal(file, "/usr/bin/open");
        assert.ok(args[0].endsWith("PiNotify.app"), "Only the notification helper may be opened");
        notifications.push(args);
        done(null, "");
      }
      // All child processes are intercepted; no applications actually open.
      return {};
    });
    t.mock.method(Date, "now", () => now);
    syncBuiltinESMExports();
    const handlers = new Map();
    const ctx = { cwd: "/synthetic/project", ui: { notify: () => assert.fail("Unexpected missing-app warning") } };
    macosNotify({ on: (name, handler) => handlers.set(name, handler) });
    await handlers.get("agent_start")({}, ctx);
    now += duration;
    await handlers.get("agent_end")({}, ctx);
    await handlers.get("session_shutdown")({}, ctx);
    return { scripts, notifications, ttyWrites };
  } finally {
    for (const key of terminalEnv) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
}

for (const [label, env] of [
  ["Herdr terminal name", { TERM_PROGRAM: "herdr" }],
  ["Herdr environment flag with inherited Terminal name", { TERM_PROGRAM: "Apple_Terminal", HERDR_ENV: "1" }],
  ["Herdr pane with inherited Ghostty name", { TERM_PROGRAM: "ghostty", HERDR_PANE_ID: "fixture-pane" }],
  ["Herdr session with inherited iTerm name", { TERM_PROGRAM: "iTerm.app", HERDR_SESSION: "fixture-session" }],
  ["empty pane variable with a Herdr session", { TERM_PROGRAM: "Apple_Terminal", HERDR_PANE_ID: "", HERDR_SESSION: "fixture-session" }],
  ["unknown terminal", { TERM_PROGRAM: "fixture-unknown" }],
  ["missing terminal metadata", {}],
]) {
  test(`${label}: notify without any app/tab probes`, async t => {
    const result = await finishTurn(t, env);
    assert.deepEqual(result.scripts, []);
    assert.deepEqual(result.ttyWrites, []);
    assert.equal(result.notifications.length, 1);
    assert.equal(result.notifications[0][3], "Done — 4s");
  });
}

for (const [terminal, appId, tellTarget] of [
  ["ghostty", "com.mitchellh.ghostty", 'tell application "System Events"'],
  ["iTerm.app", "com.googlecode.iterm2", 'tell application "iTerm2"'],
  ["Apple_Terminal", "com.apple.Terminal", 'tell application "Terminal"'],
]) {
  test(`${terminal}: guard running state before the single supported app query`, async t => {
    const result = await finishTurn(t, { TERM_PROGRAM: terminal });
    assert.equal(result.scripts.length, 1);
    const script = result.scripts[0].trim();
    assert.ok(script.startsWith(`if not (application id "${appId}" is running) then return ""`));
    assert.ok(script.indexOf(tellTarget) > script.indexOf("is running"));
    assert.equal(result.notifications.length, 1);
    assert.match(result.notifications[0][3], /π - project · tab 1/);
  });
}

test("closed Terminal yields a plain notification without fallback probes", async t => {
  const result = await finishTurn(t, { TERM_PROGRAM: "Apple_Terminal" }, { running: false });
  assert.equal(result.scripts.length, 1);
  assert.match(result.scripts[0], /if not \(application id "com.apple.Terminal" is running\) then return ""/);
  assert.equal(result.notifications[0][3], "Done — 4s");
});

test("failed supported lookup still notifies without probing another terminal", async t => {
  const result = await finishTurn(t, { TERM_PROGRAM: "ghostty" }, { failLookup: true });
  assert.equal(result.scripts.length, 1);
  assert.equal(result.notifications[0][3], "Done — 4s");
});

test("short turns still produce no notification or app probes", async t => {
  const result = await finishTurn(t, { TERM_PROGRAM: "herdr" }, { duration: 1000 });
  assert.deepEqual(result.scripts, []);
  assert.deepEqual(result.notifications, []);
});
