import { test } from "node:test";
import assert from "node:assert/strict";
import { ControlServer } from "../src/main/control.ts";
import { prettyBinding } from "../src/renderer/components/binding.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";

/** Speak to the socket exactly as karen-ctl does. */
function ctl(path: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.on("connect", () => socket.write(`${line}\n`));
    socket.on("data", (c: Buffer) => { socket.end(); resolve(c.toString("utf8").trim()); });
    socket.on("error", reject);
  });
}

async function withServer<T>(
  handle: (c: string) => string | Promise<string>,
  body: (path: string, seen: string[]) => Promise<T>,
): Promise<T> {
  const seen: string[] = [];
  const path = join(mkdtempSync(join(tmpdir(), "karen-ctl-")), "karen.sock");
  const server = new ControlServer({
    socketPath: path,
    handle: async (c) => { seen.push(c); return handle(c); },
  });
  await server.start();
  try {
    return await body(path, seen);
  } finally {
    await server.stop();
  }
}

test("a hotkey press reaches the app as one command", async () => {
  await withServer(() => "recording", async (path, seen) => {
    assert.equal(await ctl(path, "dictate-toggle"), "recording");
    assert.deepEqual(seen, ["dictate-toggle"]);
  });
});

test("an unknown command is refused rather than acted on", async () => {
  // The socket is reachable by anything running as this user; it must expose
  // dictation and nothing else.
  await withServer(() => "ok", async (path, seen) => {
    assert.match(await ctl(path, "rm -rf /"), /^error: unknown command/);
    assert.match(await ctl(path, "dictate-everything"), /^error: unknown command/);
    assert.deepEqual(seen, [], "an unknown command must never reach the handler");
  });
});

test("a handler failure comes back as an error, not a hang", async () => {
  await withServer(() => { throw new Error("no microphone"); }, async (path) => {
    assert.equal(await ctl(path, "dictate-start"), "error: no microphone");
  });
});

test("several presses on one connection are handled in order", async () => {
  // GNOME spawns a fresh karen-ctl per press, but the framing must not depend
  // on that: two lines in one write is a legitimate stream.
  await withServer((c) => c, async (path, seen) => {
    await new Promise<void>((resolve, reject) => {
      const socket = connect(path);
      let got = "";
      socket.on("connect", () => socket.write("dictate-start\ndictate-stop\n"));
      socket.on("data", (c: Buffer) => {
        got += c.toString("utf8");
        if (got.split("\n").filter(Boolean).length === 2) { socket.end(); resolve(); }
      });
      socket.on("error", reject);
    });
    assert.deepEqual(seen, ["dictate-start", "dictate-stop"]);
  });
});

test("a stale socket from an unclean exit does not block startup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "karen-stale-"));
  const path = join(dir, "karen.sock");
  const first = new ControlServer({ socketPath: path, handle: () => "one" });
  await first.start();
  // Simulate a crash: the process is gone but the socket file remains.
  const second = new ControlServer({ socketPath: path, handle: () => "two" });
  await second.start();
  try {
    assert.equal(await ctl(path, "ping"), "two");
  } finally {
    await second.stop();
    await first.stop().catch(() => undefined);
  }
});

test("GNOME's binding syntax is shown the way a person reads it", () => {
  assert.equal(prettyBinding("<Super>d"), "Super + D");
  assert.equal(prettyBinding("<Super><Alt>d"), "Super + Alt + D");
  assert.equal(prettyBinding("<Ctrl><Shift>space"), "Ctrl + Shift + space");
  assert.equal(prettyBinding("<Primary>m"), "Ctrl + M");
});

/*
 * Two layers of quoting sit between "install a hotkey" and "a key press runs a
 * command", and getting either wrong produces the same symptom: the binding
 * appears in GNOME's settings and does nothing at all.
 *
 *   1. gsettings parses the VALUE as a GVariant
 *   2. GNOME parses the stored COMMAND with g_shell_parse_argv
 *
 * This repo's own path contains a space, so both were hit for real.
 */
test("a value is stored as a GVariant string, not handed over raw", async () => {
  const { gvariantString } = await import("../src/main/hotkey.ts");
  assert.equal(gvariantString("<Super>d"), '"<Super>d"');
  // The command is already shell-quoted, so it starts with a quote — which is
  // exactly what gsettings mis-parsed as a GVariant before this existed.
  assert.equal(gvariantString("'/usr/bin/node' '/o p/x.js' go"), '"\'/usr/bin/node\' \'/o p/x.js\' go"');
  assert.equal(gvariantString('say "hi"'), '"say \\"hi\\""');
  assert.equal(gvariantString("back\\slash"), '"back\\\\slash"');
});

test("what gsettings prints can be read back, in either quote style", async () => {
  const { unquote, parseList } = await import("../src/main/hotkey.ts");
  assert.equal(unquote("'<Super>d'"), "<Super>d");
  assert.equal(unquote('"<Super>d"'), "<Super>d");
  assert.equal(unquote('"say \\"hi\\""'), 'say "hi"');
  assert.deepEqual(parseList("@as []"), []);
  assert.deepEqual(parseList("[]"), []);
  assert.deepEqual(parseList("['/a/', '/b/']"), ["/a/", "/b/"]);
});

test("a command with a space survives shell parsing", () => {
  // Mirrors g_shell_parse_argv, which is what GNOME uses to run the command.
  const quote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const command = `${quote("/usr/bin/node")} ${quote("/home/me/pi agent/ctl.js")} dictate-toggle`;
  const argv = [...command.matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2]!);
  assert.deepEqual(argv, ["/usr/bin/node", "/home/me/pi agent/ctl.js", "dictate-toggle"]);
});
