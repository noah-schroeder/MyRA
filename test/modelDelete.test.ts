/**
 * Deleting a model, and knowing whose file it was.
 *
 * Three acts wear one word. Lemonade removes what it downloaded; asked about
 * anything reached through `extra_models_dir` it answers 500 with
 * `Cannot delete extra models via API … Delete the file directly from: <path>`,
 * naming a path inside Karen's **index** -- a tree of symlinks rebuilt from
 * scratch on every start. Deleting that path removes a link and leaves the
 * gigabytes exactly where they were.
 *
 * So the delete follows the links, and these pin the two rules that follow
 * from that: the real path comes from `realpath` rather than from an id the
 * window sent, and a resolved target outside a folder Karen already knows
 * fails the whole delete rather than being followed.
 *
 * The user's decision is pinned here too: LM Studio's and Ollama's models are
 * deletable, after a warning that names the file and says what that other
 * application is likely to do about it.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, readdir, symlink, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ForeignModel } from "../src/core/runtime/foreign.ts";
import { deletePrompt, ownerLabel, ownerOf } from "../src/core/runtime/modelOwner.ts";
import { deleteModel } from "../src/main/runtime/modelDelete.ts";
import { LemonadeApiError } from "../src/main/runtime/lemonadeApi.ts";

const REFUSAL = new LemonadeApiError(
  "/api/delete failed (500): {\"error\":\"Cannot delete extra models via API. Models in --extra-models-dir are user-managed. Delete the file directly from: /x\"}",
);

/** A models folder mirrored into an index of symlinks, as the app builds it. */
async function scaffold(): Promise<{ root: string; modelsDir: string; indexDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "karen-del-"));
  const modelsDir = join(root, "models");
  const indexDir = join(root, "index");
  await mkdir(join(modelsDir, "Mine-GGUF"), { recursive: true });
  await writeFile(join(modelsDir, "Mine-GGUF", "mine.gguf"), "weights");
  await mkdir(join(indexDir, "Mine-GGUF"), { recursive: true });
  await symlink(join(modelsDir, "Mine-GGUF", "mine.gguf"), join(indexDir, "Mine-GGUF", "mine.gguf"));
  return { root, modelsDir, indexDir };
}

const exists = async (p: string): Promise<boolean> =>
  Boolean(await stat(p).catch(() => undefined));

describe("who owns a model", () => {
  it("is the other application whenever the index says so", () => {
    /* Lemonade calls every indexed model `extra_models_dir` because that is the
       only door it has, so the index's own record has to win. */
    assert.equal(ownerOf({ source: "extra_models_dir", foreign: "lmstudio" }), "lmstudio");
    assert.equal(ownerOf({ source: "extra_models_dir" }), "karen-folder");
    assert.equal(ownerOf({ source: "huggingface" }), "karen");
    assert.equal(ownerOf({}), "karen");
  });

  it("names the application in words a person recognises", () => {
    assert.equal(ownerLabel("lmstudio"), "LM Studio");
    assert.equal(ownerLabel("ollama"), "Ollama");
    assert.equal(ownerLabel("karen-folder"), "Karen");
  });
});

describe("what the confirmation says", () => {
  it("asks once for a model Karen downloaded", () => {
    const p = deletePrompt({ owner: "karen", name: "Qwen3-8B", size: "4.9 GB" });
    assert.equal(p.warns, false);
    assert.equal(p.confirm, "Delete");
    assert.match(p.body, /4\.9 GB/);
  });

  it("warns first for a file belonging to another application", () => {
    const p = deletePrompt({
      owner: "lmstudio", name: "Qwen3-8B", size: "4.9 GB", path: "/home/me/.lmstudio/x.gguf",
    });
    assert.equal(p.warns, true);
    assert.equal(p.reveal, true);
    // Differently worded from the ordinary one, so the second press is a decision.
    assert.notEqual(p.confirm, "Delete");
    assert.match(p.confirm, /LM Studio/);
    assert.match(p.body, /\/home\/me\/\.lmstudio\/x\.gguf/);
    assert.match(p.body, /deleting it in LM Studio instead/i);
  });

  it("says what is peculiar to Ollama rather than a generic caution", () => {
    /* Ollama stores models as shared content blocks, so the file this row names
       may be part of another model -- not inferable from a filename that is a
       hash. */
    const p = deletePrompt({ owner: "ollama", name: "llama3.2:3b" });
    assert.match(p.body, /shared blocks/);
  });

  it("says when the backend has to restart, and when it does not", () => {
    assert.equal(deletePrompt({ owner: "karen", name: "x" }).restarts, false);
    assert.equal(deletePrompt({ owner: "karen-folder", name: "x" }).restarts, true);
    assert.equal(deletePrompt({ owner: "ollama", name: "x" }).restarts, true);
  });
});

describe("deleting", () => {
  it("lets the daemon do it when the daemon can", async () => {
    let asked: string | undefined;
    const result = await deleteModel("Whisper-Tiny", {
      deleteViaDaemon: async (id) => { asked = id; },
      foreign: [],
      modelsDir: "/nowhere",
      indexDir: "/nowhere",
      rescan: async () => assert.fail("no restart is needed for the daemon's own delete"),
    });
    assert.equal(asked, "Whisper-Tiny");
    assert.deepEqual(result, { owner: "karen", removed: ["Whisper-Tiny"], restarted: false });
  });

  it("follows the index's links when the daemon hands it back", async () => {
    const { modelsDir, indexDir } = await scaffold();
    let rescanned = false;
    const result = await deleteModel("Mine-GGUF", {
      deleteViaDaemon: async () => { throw REFUSAL; },
      foreign: [],
      modelsDir,
      indexDir,
      rescan: async () => { rescanned = true; },
    });

    assert.equal(result.owner, "karen-folder");
    assert.equal(result.restarted, true);
    // The real file, not the link, and the emptied directory with it.
    assert.equal(await exists(join(modelsDir, "Mine-GGUF", "mine.gguf")), false);
    assert.equal(await exists(join(modelsDir, "Mine-GGUF")), false);
    // The models folder itself is never removed.
    assert.equal(await exists(modelsDir), true);
    assert.equal(rescanned, true);
  });

  it("deletes another application's file, since that is what was asked for", async () => {
    const { root, indexDir } = await scaffold();
    const library = join(root, "lmstudio", "publisher", "repo");
    await mkdir(library, { recursive: true });
    await writeFile(join(library, "theirs.gguf"), "weights");
    await mkdir(join(indexDir, "theirs"), { recursive: true });
    await symlink(join(library, "theirs.gguf"), join(indexDir, "theirs", "theirs.gguf"));
    const foreign: ForeignModel = {
      id: "theirs", label: "theirs", source: "lmstudio",
      path: join(library, "theirs.gguf"), linkName: "theirs.gguf",
    };

    const result = await deleteModel("theirs", {
      deleteViaDaemon: async () => assert.fail("the daemon is never asked about somebody else's file"),
      foreign: [foreign],
      modelsDir: join(root, "models"),
      indexDir,
      rescan: async () => {},
    });

    assert.equal(result.owner, "lmstudio");
    assert.equal(await exists(join(library, "theirs.gguf")), false);
    /* Their directory structure is left alone: emptying it is not the same as
       being asked to tidy their library. */
    assert.equal(await exists(library), true);
  });

  it("refuses a link that points outside the folders it was given", async () => {
    const { root, modelsDir, indexDir } = await scaffold();
    const elsewhere = join(root, "elsewhere.gguf");
    await writeFile(elsewhere, "not ours");
    await mkdir(join(indexDir, "Escape"), { recursive: true });
    await symlink(elsewhere, join(indexDir, "Escape", "escape.gguf"));

    await assert.rejects(
      deleteModel("Escape", {
        deleteViaDaemon: async () => { throw REFUSAL; },
        foreign: [],
        modelsDir,
        indexDir,
        rescan: async () => assert.fail("nothing should have been deleted"),
      }),
      /not inside a folder Karen manages/,
    );
    assert.equal(await exists(elsewhere), true);
  });

  it("passes a real failure through instead of deleting files over it", async () => {
    /* Falling through on every error would turn "the daemon is not running"
       into an unexplained file deletion. */
    const { modelsDir, indexDir } = await scaffold();
    await assert.rejects(
      deleteModel("Mine-GGUF", {
        deleteViaDaemon: async () => { throw new LemonadeApiError("could not reach Lemonade"); },
        foreign: [],
        modelsDir,
        indexDir,
        rescan: async () => assert.fail("nothing should have been deleted"),
      }),
      /could not reach Lemonade/,
    );
    assert.equal(await exists(join(modelsDir, "Mine-GGUF", "mine.gguf")), true);
  });

  it("says so rather than reporting success when there is nothing to remove", async () => {
    const { modelsDir, indexDir } = await scaffold();
    await assert.rejects(
      deleteModel("Not-Here", {
        deleteViaDaemon: async () => { throw REFUSAL; },
        foreign: [],
        modelsDir,
        indexDir,
        rescan: async () => assert.fail("nothing was deleted"),
      }),
      /Nothing has been deleted/,
    );
    assert.equal((await readdir(modelsDir)).length, 1);
  });
});
