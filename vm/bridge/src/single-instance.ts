/**
 * One bridge per machine.
 *
 * The app keeps a single host link and closes the older one when a new bridge
 * connects. Two bridges therefore displace each other indefinitely -- each
 * reconnects, supersedes the other, and is superseded in turn. Left alone it
 * reconnects about a thousand times a second, saturates the app's event loop
 * until it stops answering its sockets at all, and produces a log measured in
 * hundreds of megabytes. Observed, in this repo, twice.
 *
 * Standing down when superseded helps, but it is a race: whichever process
 * happens to connect last wins, and a third connection can displace the winner
 * before it settles. This is the deterministic half -- a second bridge never
 * connects in the first place.
 */

import { openSync, closeSync, readFileSync, writeSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function lockPath(): string {
  const runtime =
    process.env["XDG_RUNTIME_DIR"] ?? join(homedir(), ".cache");
  return join(runtime, "karen-bridge.pid");
}

/** True when a process with this pid exists and we may signal it. */
export function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else, which still counts.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface Lock {
  release: () => void;
}

/**
 * Take the lock, or return undefined if another live bridge holds it.
 *
 * A stale file -- left by a bridge that was killed -- is taken over rather than
 * treated as a conflict, because otherwise a hard kill would require the user
 * to delete a file by hand before Karen worked again.
 */
export function acquire(path = lockPath()): Lock | undefined {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      const release = () => {
        try {
          // Only remove it if it is still ours: a slow shutdown must not delete
          // the lock a successor has already taken.
          if (Number(readFileSync(path, "utf8").trim()) === process.pid) unlinkSync(path);
        } catch {
          /* already gone */
        }
      };
      return { release };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      let holder = 0;
      try {
        holder = Number(readFileSync(path, "utf8").trim());
      } catch {
        /* unreadable: treat as stale */
      }
      if (isRunning(holder) && holder !== process.pid) return undefined;

      try {
        unlinkSync(path);
      } catch {
        /* someone else cleaned it up first; try again */
      }
    }
  }
  return undefined;
}
