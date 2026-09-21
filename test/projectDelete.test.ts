/**
 * Deleting a project, which is the one action here that destroys work.
 *
 * A project is an index over five stores that have never heard of it, so
 * deleting one means asking each store to delete its own — five deletes MyRA
 * does not own, any of which can refuse. `deleteRun` really does refuse: it
 * declines to remove a run written to in the last ninety seconds, because that
 * looks like a run still going. If one refusal abandoned the loop, a project
 * would be left half emptied with no account of what survived.
 *
 * The other half is the promise the confirm dialog makes. "Keep the contents,
 * delete the project" has to delete exactly nothing, and that is worth a test
 * rather than a careful reading.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newProject, type Member, type Project } from "../src/core/projects/project.ts";
import {
  deleteProject, filedRefs, fileInActiveProject, projectsDir, readAll, readAllPruned, readProject,
  writeProject, type ProjectStores,
} from "../src/main/projectStore.ts";

/**
 * What every real store's assertRef does, stood in for here.
 *
 * Not a permissive stub. The interface requires this precisely so a fake
 * cannot quietly be the one store with no guard, which is how the real
 * meeting store came to be missing one.
 */
function realRef(ref: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(ref) || ref === "." || ref === "..") {
    throw new Error(`no item named ${JSON.stringify(ref)}`);
  }
  return ref;
}

/** A store that records what it was asked to do, and can be told to refuse. */
function fake(rows: string[], refuse?: string) {
  const removed: string[] = [];
  return {
    removed,
    store: {
      assertRef: realRef,
      list: async () => rows.map((ref) => ({ ref, title: ref, at: "", note: "" })),
      remove: async (ref: string) => {
        if (ref === refuse) throw new Error("still being written to");
        removed.push(ref);
      },
      payload: async () => ({}),
    },
  };
}

function stores(over: Partial<ProjectStores> = {}): ProjectStores {
  const empty = {
    assertRef: realRef, list: async () => [], remove: async () => {}, payload: async () => ({}),
  };
  return { chat: empty, meeting: empty, run: empty, paper: empty, review: empty, image: empty, ...over };
}

function project(members: Member[]): Project {
  return { ...newProject({ name: "NSF concept note" }), members };
}

/* MYRA_PROJECTS_DIR is read on every call rather than bound at import, so a
   test can point it somewhere of its own. test/setup.ts already redirects
   MYRA_CONFIG_DIR; this is the same trick one level down. */
async function inTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "myra-projects-"));
  process.env["MYRA_PROJECTS_DIR"] = dir;
  return dir;
}

describe("deleting everything", () => {
  it("asks each store to remove its own, once per member", async () => {
    await inTempDir();
    const chats = fake(["c1", "c2"]);
    const papers = fake(["p1"]);
    const p = await writeProject(
      project([
        { kind: "chat", ref: "c1" },
        { kind: "chat", ref: "c2" },
        { kind: "paper", ref: "p1" },
      ]),
    );

    const report = await deleteProject(p, stores({ chat: chats.store, paper: papers.store }), {
      contents: true,
    });

    assert.deepEqual(chats.removed, ["c1", "c2"]);
    assert.deepEqual(papers.removed, ["p1"]);
    assert.deepEqual(report.removed.sort((a, b) => a.kind.localeCompare(b.kind)), [
      { kind: "chat", count: 2 },
      { kind: "paper", count: 1 },
    ]);
    // And the record itself is gone.
    assert.equal(await readProject(p.id), undefined);
  });

  it("carries on past a refusal, and reports it", async () => {
    await inTempDir();
    /* The real case: a research run written to seconds ago declines, because it
       looks like it is still going. Everything else must still go. */
    const runs = fake(["r1"], "r1");
    const chats = fake(["c1"]);
    const p = await writeProject(
      project([
        { kind: "run", ref: "r1" },
        { kind: "chat", ref: "c1" },
      ]),
    );

    const report = await deleteProject(p, stores({ run: runs.store, chat: chats.store }), {
      contents: true,
    });

    assert.deepEqual(chats.removed, ["c1"]);
    assert.equal(report.failed.length, 1);
    assert.equal(report.failed[0]?.kind, "run");
    assert.match(report.failed[0]?.error ?? "", /still being written to/);
  });
});

describe("keeping the contents", () => {
  it("deletes nothing but the project record", async () => {
    await inTempDir();
    const chats = fake(["c1"]);
    const papers = fake(["p1"]);
    const p = await writeProject(
      project([
        { kind: "chat", ref: "c1" },
        { kind: "paper", ref: "p1" },
      ]),
    );

    const report = await deleteProject(p, stores({ chat: chats.store, paper: papers.store }), {
      contents: false,
    });

    assert.deepEqual(chats.removed, []);
    assert.deepEqual(papers.removed, []);
    assert.deepEqual(report.removed, []);
    assert.equal(await readProject(p.id), undefined);
  });
});

describe("the record on disk", () => {
  it("is owner-only, in an owner-only directory", async () => {
    await inTempDir();
    const p = await writeProject(project([]));
    assert.equal((await stat(projectsDir())).mode & 0o777, 0o700);
    assert.equal((await stat(join(projectsDir(), `${p.id}.json`))).mode & 0o777, 0o600);
  });

  it("leaves no .partial behind, so a listing sees only finished records", async () => {
    await inTempDir();
    await writeProject(project([]));
    assert.deepEqual(
      (await readdir(projectsDir())).filter((n) => n.endsWith(".partial")),
      [],
    );
  });

  it("skips a file that is not a record, rather than failing the whole list", async () => {
    const dir = await inTempDir();
    await writeProject(project([]));
    await writeFile(join(dir, "broken.json"), "{ not json");
    assert.equal((await readAll()).length, 1);
  });
});

describe("pruning on read", () => {
  it("drops a member whose item has been deleted from its own page", async () => {
    await inTempDir();
    const p = await writeProject(
      project([
        { kind: "chat", ref: "still-here" },
        { kind: "chat", ref: "deleted-elsewhere" },
      ]),
    );
    /* The store only knows about one of them now -- somebody deleted the other
       from the rail, which has never heard of projects. */
    const [pruned] = await readAllPruned(stores({ chat: fake(["still-here"]).store }));

    assert.deepEqual(pruned?.members, [{ kind: "chat", ref: "still-here" }]);
    // Persisted, so the next read does no work.
    assert.deepEqual((await readProject(p.id))?.members, [{ kind: "chat", ref: "still-here" }]);
  });

  it("prunes nothing when a store cannot be listed at all", async () => {
    await inTempDir();
    /* A meetings folder on an unplugged disk answers with an error, not an
       empty list. Treating that as "everything is gone" would empty the
       project; a row that opens nothing is recoverable and this is not. */
    await writeProject(project([{ kind: "meeting", ref: "kickoff" }]));
    const broken = {
      assertRef: realRef,
      list: async (): Promise<never> => {
        throw new Error("no such directory");
      },
      remove: async () => {},
      payload: async () => ({}),
    };
    const [pruned] = await readAllPruned(stores({ meeting: broken }));
    assert.deepEqual(pruned?.members, [{ kind: "meeting", ref: "kickoff" }]);
  });
});

describe("what a project holds", () => {
  it("is what \"delete all conversations\" has to spare", async () => {
    await inTempDir();
    await writeProject(project([
      { kind: "chat", ref: "grant-kickoff" },
      { kind: "paper", ref: "grant-draft" },
    ]));
    await writeProject(project([{ kind: "chat", ref: "other-project-chat" }]));

    /* Chats only: the broom in the rail deletes conversations, and a paper
       sharing a date-stamped id with one is a plausible collision rather than
       a theoretical one. */
    assert.deepEqual([...(await filedRefs("chat"))].sort(), ["grant-kickoff", "other-project-chat"]);
    assert.deepEqual([...(await filedRefs("paper"))], ["grant-draft"]);
    assert.deepEqual([...(await filedRefs("meeting"))], []);
  });
});

describe("filing new work", () => {
  const config = (activeProject: string) =>
    ({ current: { activeProject } }) as unknown as Parameters<typeof fileInActiveProject>[0];

  it("puts it in the active project", async () => {
    await inTempDir();
    const p = await writeProject(project([]));
    await fileInActiveProject(config(p.id), "chat", "c1");
    assert.deepEqual((await readProject(p.id))?.members, [{ kind: "chat", ref: "c1" }]);
  });

  it("does nothing when no project is active", async () => {
    await inTempDir();
    const p = await writeProject(project([]));
    await fileInActiveProject(config(""), "chat", "c1");
    assert.deepEqual((await readProject(p.id))?.members, []);
  });

  it("does nothing when the active project has been deleted", async () => {
    await inTempDir();
    /* A stale id in settings must not resurrect a record. Nothing on screen
       would ever show what it had collected. */
    await fileInActiveProject(config("20260101-0000-gone"), "chat", "c1");
    assert.equal(await readProject("20260101-0000-gone"), undefined);
  });
});


/**
 * The delete path is the last line, and it has to be.
 *
 * `myra:project-delete` reads with `readProject`, not `readAllPruned`, so the
 * pruning that drops a member whose file has vanished never runs here. A
 * member written straight to disk -- by a hand edit, a sync client, or a build
 * with a bug in it -- reaches `stores[kind].remove` directly, and for a
 * meeting that is `rm -rf` over join(meetingsRoot(), ref).
 */
describe("a ref that is not one its store addresses", () => {
  it("is refused rather than removed, and the members beside it still go", async () => {
    const meetings = fake([]);
    const chats = fake(["c1"]);
    const p = project([
      { kind: "meeting", ref: "../../../../tmp/myra-escape-target" },
      { kind: "chat", ref: "c1" },
    ]);

    const report = await deleteProject(p, stores({ meeting: meetings.store, chat: chats.store }), {
      contents: true,
    });

    assert.deepEqual(meetings.removed, [], "the traversal never reached remove()");
    assert.deepEqual(chats.removed, ["c1"], "and the members beside it were still removed");
    assert.deepEqual(
      report.failed.map((f) => f.ref),
      ["../../../../tmp/myra-escape-target"],
      "the refusal is reported rather than swallowed",
    );
  });
});
