#!/usr/bin/env node
/**
 * karen-ctl — a keypress, delivered.
 *
 * Bound to a GNOME custom keybinding, this is what actually runs when the user
 * hits the dictation hotkey. It must start fast and exit fast: the compositor
 * spawns it on every press, so anything slow here is felt as lag before
 * recording begins.
 *
 * It therefore does the least possible: connect, write one line, print the
 * reply, exit. No Electron, no dependencies, no config file.
 */

import { connect } from "node:net";

const USAGE = `karen-ctl — control a running Karen

Usage:
  karen-ctl dictate-toggle   start dictation, or stop and transcribe
  karen-ctl dictate-start    start dictation
  karen-ctl dictate-stop     stop and transcribe
  karen-ctl ping             check Karen is running

Bind dictate-toggle to a key in GNOME Settings → Keyboard, or let Karen do it
for you in Settings → Dictation.`;

function socketPath(): string {
  const runtime = process.env["XDG_RUNTIME_DIR"] ?? `/run/user/${process.getuid?.() ?? 1000}`;
  return `${runtime}/karen.sock`;
}

const command = process.argv[2];
if (!command || command === "--help" || command === "-h") {
  console.log(USAGE);
  process.exit(command ? 0 : 1);
}

const path = socketPath();
const socket = connect(path);
let answered = false;

// The hotkey may be pressed before the app is up, or after it has gone. Say so
// plainly rather than hanging on a socket nobody is listening to.
const timer = setTimeout(() => {
  if (!answered) {
    console.error(`karen-ctl: Karen did not answer at ${path}`);
    process.exit(1);
  }
}, 5_000);

socket.on("connect", () => socket.write(`${command}\n`));

socket.on("data", (chunk: Buffer) => {
  answered = true;
  clearTimeout(timer);
  const reply = chunk.toString("utf8").trim();
  if (reply.startsWith("error:")) {
    console.error(`karen-ctl: ${reply.slice("error:".length).trim()}`);
    socket.end();
    process.exit(1);
  }
  if (reply) console.log(reply);
  socket.end();
  process.exit(0);
});

socket.on("error", (err: NodeJS.ErrnoException) => {
  clearTimeout(timer);
  console.error(
    err.code === "ENOENT" || err.code === "ECONNREFUSED"
      ? "karen-ctl: Karen is not running"
      : `karen-ctl: ${err.message}`,
  );
  process.exit(1);
});
