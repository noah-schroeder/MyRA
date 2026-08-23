/**
 * Session listing and deletion.
 *
 * Deletion is irreversible and takes an id from a client, so most of what is
 * pinned here is about what must NOT be deleted.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteAllSessions, deleteSession, listSessions, summarize } from "../src/sessions.ts";

function line(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

async function fixture(): Promise<{ sessions: string; research: string }> {
  const root = await mkdtemp(join(tmpdir(), "sess-"));
  const sessions = join(root, "sessions");
  const research = join(root, "research");
  await mkdir(sessions, { recursive: true });
  await mkdir(join(research, "2026-08-19-training-transfer-a1b2"), { recursive: true });
  await mkdir(join(research, "2026-08-18-other-run-99ff"), { recursive: true });
  await writeFile(join(research, "2026-08-19-training-transfer-a1b2", "report.md"), "x");
  await writeFile(join(research, "2026-08-18-other-run-99ff", "report.md"), "y");

  await writeFile(join(sessions, "a.jsonl"),
    line({ type: "session", timestamp: "2026-08-19T10:00:00.000Z" }) +
    line({ type: "message", timestamp: "2026-08-19T10:00:01.000Z",
           message: { role: "user", content: [{ type: "text", text: "Does working memory training transfer?" }] } }) +
    line({ type: "message", timestamp: "2026-08-19T10:05:00.000Z",
           message: { role: "assistant", content: [{ type: "text", text: "Run id: 2026-08-19-training-transfer-a1b2" }] } }));

  await writeFile(join(sessions, "b.jsonl"),
    line({ type: "session", timestamp: "2026-08-20T09:00:00.000Z" }) +
    line({ type: "message", timestamp: "2026-08-20T09:00:01.000Z",
           message: { role: "user", content: [{ type: "text", text: "hello there" }] } }));
  return { sessions, research };
}

test("sessions are listed newest first, titled by their first question", async () => {
  const { sessions } = await fixture();
  const list = await listSessions(sessions);
  assert.equal(list.length, 2);
  assert.equal(list[0]!.id, "b.jsonl", "newest first");
  assert.equal(list[1]!.title, "Does working memory training transfer?");
  assert.equal(list[1]!.messages, 2);
});

test("the composed deep-research directive is stripped from the title", async () => {
  const root = await mkdtemp(join(tmpdir(), "title-"));
  await writeFile(join(root, "c.jsonl"),
    line({ type: "session", timestamp: "2026-08-19T10:00:00.000Z" }) +
    line({ type: "message", message: { role: "user", content: [{ type: "text",
      text: "Run deep_research with this question, exactly as written, and present its report verbatim:\n\nDo agents help learning?" }] } }));
  // Otherwise every research chat in the sidebar has the same opening words.
  assert.equal((await summarize(join(root, "c.jsonl")))!.title, "Do agents help learning?");
});

test("a malformed line does not lose the rest of the file", async () => {
  const root = await mkdtemp(join(tmpdir(), "torn-"));
  await writeFile(join(root, "d.jsonl"),
    line({ type: "session", timestamp: "2026-08-19T10:00:00.000Z" }) +
    "{ this is not json\n" +
    line({ type: "message", message: { role: "user", content: [{ type: "text", text: "still here" }] } }));
  const s = await summarize(join(root, "d.jsonl"));
  assert.equal(s!.title, "still here");
});

test("deleting a chat also deletes the research runs it started", async () => {
  const { sessions, research } = await fixture();
  const result = await deleteSession("a.jsonl", sessions, research);
  assert.deepEqual(result.runsDeleted, ["2026-08-19-training-transfer-a1b2"]);
  assert.equal(existsSync(join(sessions, "a.jsonl")), false);
  assert.equal(existsSync(join(research, "2026-08-19-training-transfer-a1b2")), false);
  // A run that this chat never mentioned belongs to some other chat.
  assert.equal(existsSync(join(research, "2026-08-18-other-run-99ff")), true);
});

test("an id that escapes the session directory is refused", async () => {
  const { sessions, research } = await fixture();
  for (const bad of ["../research/2026-08-18-other-run-99ff", "../../etc/passwd", "a.jsonl/../../b"]) {
    await assert.rejects(() => deleteSession(bad, sessions, research), /refusing to delete outside/);
  }
  // Nothing was touched by the attempts.
  assert.equal((await readdir(sessions)).length, 2);
  assert.equal(existsSync(join(research, "2026-08-18-other-run-99ff")), true);
});

test("only .jsonl files can be deleted", async () => {
  const { sessions, research } = await fixture();
  await writeFile(join(sessions, "notes.txt"), "keep me");
  await assert.rejects(() => deleteSession("notes.txt", sessions, research), /refusing to delete/);
  assert.equal(existsSync(join(sessions, "notes.txt")), true);
});

test("clearing everything removes every chat and every run they started", async () => {
  const { sessions, research } = await fixture();
  const result = await deleteAllSessions(sessions, research);
  assert.equal(result.sessions, 2);
  assert.equal(result.runsDeleted, 1);
  assert.deepEqual(await readdir(sessions), []);
  // An orphan run belongs to no chat, so clearing chats must not remove it.
  assert.equal(existsSync(join(research, "2026-08-18-other-run-99ff")), true);
});
