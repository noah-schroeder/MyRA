/**
 * The permissions Karen writes with.
 *
 * These are asserted rather than assumed because the failure is silent: a
 * default `mkdir` takes the umask, produces 0775 on a stock Ubuntu, and nothing
 * anywhere reports that a meeting transcript is readable by the other accounts
 * on the machine. That is precisely the kind of thing a test is for -- it costs
 * nothing to check and it is invisible when it regresses.
 *
 * The umask is forced inside each test so the result does not depend on the
 * shell the suite happened to be started from.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  makeOwnDir, makePrivateDir, OWNER_ONLY_DIR, OWNER_ONLY_FILE,
} from "../src/core/paths.ts";

let root = "";
let umaskBefore = 0;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "karen-perm-"));
  // The loosest realistic umask, so a test that passes here passes anywhere.
  umaskBefore = process.umask(0o000);
});

after(async () => {
  process.umask(umaskBefore);
  await rm(root, { recursive: true, force: true });
});

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

describe("directories Karen creates", () => {
  it("is owner-only, whatever the umask says", async () => {
    const dir = join(root, "fresh");
    await makePrivateDir(dir);
    assert.equal(await modeOf(dir), OWNER_ONLY_DIR);
  });

  it("makes every level private, not only the last", async () => {
    const deep = join(root, "a", "b", "c");
    await makePrivateDir(deep);
    assert.equal(await modeOf(join(root, "a")), OWNER_ONLY_DIR);
    assert.equal(await modeOf(join(root, "a", "b")), OWNER_ONLY_DIR);
    assert.equal(await modeOf(deep), OWNER_ONLY_DIR);
  });

  it("leaves a directory the user chose exactly as they left it", async () => {
    /* makePrivateDir is used for content roots, which are configurable. Someone
       who deliberately shares the folder their meetings are filed in should not
       find Karen has quietly closed it. */
    const shared = join(root, "shared");
    await makePrivateDir(shared);
    const { chmod } = await import("node:fs/promises");
    await chmod(shared, 0o755);
    await makePrivateDir(shared);
    assert.equal(await modeOf(shared), 0o755);
  });
});

describe("directories Karen owns outright", () => {
  it("is tightened even when it already exists", async () => {
    /* The upgrade path: an install from before this existed has a 0775 config
       directory, and nothing would ever narrow it without this. */
    const own = join(root, "own");
    await makePrivateDir(own);
    const { chmod } = await import("node:fs/promises");
    await chmod(own, 0o775);
    await makeOwnDir(own);
    assert.equal(await modeOf(own), OWNER_ONLY_DIR);
  });

  it("does not fight a stricter mode someone set on purpose", async () => {
    const own = join(root, "stricter");
    await makeOwnDir(own);
    const { chmod } = await import("node:fs/promises");
    await chmod(own, 0o500);
    await makeOwnDir(own);
    assert.equal(await modeOf(own), 0o500);
  });
});

describe("files Karen writes", () => {
  it("is owner-only when the mode is given", async () => {
    const path = join(root, "note.md");
    await writeFile(path, "private", { encoding: "utf8", mode: OWNER_ONLY_FILE });
    assert.equal(await modeOf(path), OWNER_ONLY_FILE);
  });

  it("would otherwise be world-readable, which is the bug this guards", async () => {
    // Not a test of our code -- a test of the platform behaviour that made the
    // fix necessary. If this ever stops being true the comments above are stale.
    const path = join(root, "default.md");
    await writeFile(path, "public", "utf8");
    assert.notEqual(await modeOf(path), OWNER_ONLY_FILE);
  });
});
