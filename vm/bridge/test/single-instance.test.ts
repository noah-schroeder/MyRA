import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquire, isRunning } from "../src/single-instance.ts";

function lockFile(): string {
  return join(mkdtempSync(join(tmpdir(), "karen-lock-")), "karen-bridge.pid");
}

test("the first bridge takes the lock and the second is turned away", () => {
  // Two bridges displace each other on the app's single host link forever:
  // each reconnects, supersedes the other, and is superseded in turn. Left
  // running it reconnects about a thousand times a second and wedges the app.
  const path = lockFile();
  const first = acquire(path);
  assert.ok(first, "the first bridge must start");
  assert.equal(Number(readFileSync(path, "utf8").trim()), process.pid);

  // A second attempt by a *different* process would find this pid alive.
  assert.equal(isRunning(process.pid), true);

  first.release();
  assert.equal(existsSync(path), false, "releasing must remove the lock");
});

test("a lock left by a dead bridge is taken over, not obeyed", () => {
  // Otherwise a hard kill would leave Karen unusable until someone found and
  // deleted a file they have never heard of.
  const path = lockFile();
  writeFileSync(path, "999999\n");
  const lock = acquire(path);
  assert.ok(lock, "a stale lock must not block startup");
  assert.equal(Number(readFileSync(path, "utf8").trim()), process.pid);
  lock.release();
});

test("an unreadable or nonsense lock is treated as stale", () => {
  for (const junk of ["", "not-a-pid", "0", "-3"]) {
    const path = lockFile();
    writeFileSync(path, junk);
    const lock = acquire(path);
    assert.ok(lock, `a lock containing ${JSON.stringify(junk)} must not block startup`);
    lock.release();
  }
});

test("a live process is recognised and pid 0 and 1 are never trusted", () => {
  assert.equal(isRunning(process.pid), true);
  // Never adopt the lock of init, and never treat a bogus pid as alive.
  assert.equal(isRunning(0), false);
  assert.equal(isRunning(1), false);
  assert.equal(isRunning(-1), false);
  assert.equal(isRunning(2 ** 31), false);
});

test("releasing does not delete a successor's lock", () => {
  // A slow shutdown must not remove the lock a new bridge has already taken.
  const path = lockFile();
  const lock = acquire(path);
  assert.ok(lock);
  writeFileSync(path, "424242\n");
  lock.release();
  assert.equal(existsSync(path), true, "someone else's lock must survive our release");
});
