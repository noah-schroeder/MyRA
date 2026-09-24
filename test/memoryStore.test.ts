/**
 * A project's memory, on disk: it round-trips, it is private, and it lives
 * apart from the project record it belongs to.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addItems, newMemory } from "../src/core/projects/memory.ts";
import { deleteMemory, readMemory, writeMemory } from "../src/main/memoryStore.ts";
import { projectsDir } from "../src/main/projectStore.ts";
import { OWNER_ONLY_DIR, OWNER_ONLY_FILE } from "../src/core/paths.ts";

async function inTempDir(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "myra-memory-"));
  process.env["MYRA_PROJECTS_DIR"] = dir;
}

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

describe("a project with no memory file yet", () => {
  it("reads as a plain, already-settled memory", async () => {
    await inTempDir();
    const memory = await readMemory("no-such-project");
    assert.equal(memory.setup, "done");
    assert.deepEqual(memory.items, []);
  });
});

describe("round-tripping", () => {
  it("reads back exactly what was written", async () => {
    await inTempDir();
    const memory = addItems(newMemory({ setup: "pending" }), [{ slot: "aims", text: "Study X" }], "setup");
    await writeMemory("20260901-0900-x", memory);
    const back = await readMemory("20260901-0900-x");
    assert.equal(back.setup, "pending");
    assert.equal(back.items.length, 1);
    assert.equal(back.items[0]!.text, "Study X");
  });
});

describe("where it lives", () => {
  it("is not directly inside projects/, so readAll (a project lister) never trips over it", async () => {
    await inTempDir();
    await writeMemory("20260901-0900-x", newMemory());
    const direct = join(projectsDir(), "20260901-0900-x.json");
    await assert.rejects(stat(direct), "no memory file sits directly in the projects directory");
  });
});

describe("privacy", () => {
  it("writes its directory and file owner-only, whatever the umask says", async () => {
    const before = process.umask(0o000);
    try {
      await inTempDir();
      await writeMemory("20260901-0900-x", newMemory());
      const dir = join(projectsDir(), "memory");
      assert.equal(await modeOf(dir), OWNER_ONLY_DIR);
      assert.equal(await modeOf(join(dir, "20260901-0900-x.json")), OWNER_ONLY_FILE);
    } finally {
      process.umask(before);
    }
  });
});

describe("deleting", () => {
  it("removes the file; reading it afterwards is the same as never having written one", async () => {
    await inTempDir();
    await writeMemory("20260901-0900-x", addItems(newMemory(), [{ slot: "aims", text: "x" }], "you"));
    await deleteMemory("20260901-0900-x");
    const back = await readMemory("20260901-0900-x");
    assert.deepEqual(back.items, []);
  });

  it("deleting one that was never written is not an error", async () => {
    await inTempDir();
    await assert.doesNotReject(deleteMemory("never-existed"));
  });
});
