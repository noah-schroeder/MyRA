/**
 * Where a dropped image's or a pasted table's bytes live, read back exactly
 * as saved, and cleaned up on request. The two read functions and delete
 * share one id-to-path resolver (`resolveAttachmentPath`, not exported); the
 * property that matters here is that unifying them changed nothing about
 * what each one does -- round-trips still round-trip, a missing id is still
 * "undefined", not a thrown error.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  deleteAttachment, deleteSessionAttachments, readDataText, readImageDataUri,
  saveDataAttachment, saveImageAttachment,
} from "../src/main/attachments.ts";

/** Every test gets its own session id, since MYRA_CONFIG_DIR (see
 *  test/setup.ts) is one shared temp directory for the whole process. */
let n = 0;
function session(): string {
  return `attach-test-${process.pid}-${++n}`;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test("an image is saved, sniffed and read back as the same data: URI mime", async () => {
  const sid = session();
  const saved = await saveImageAttachment(sid, PNG);
  assert.equal(saved.mime, "image/png");
  assert.equal(saved.bytes, PNG.byteLength);
  const uri = await readImageDataUri(sid, saved.id, saved.mime);
  assert.ok(uri?.startsWith("data:image/png;base64,"));
  const decoded = Buffer.from(uri!.split(",")[1]!, "base64");
  assert.deepEqual(new Uint8Array(decoded), PNG);
});

test("bytes that do not sniff as any known image are refused", async () => {
  await assert.rejects(() => saveImageAttachment(session(), new Uint8Array([1, 2, 3, 4])), /does not look like an image/);
});

test("an image over the size ceiling is refused before anything is written", async () => {
  const huge = new Uint8Array(64 * 1024 * 1024 + 1);
  huge.set(PNG);
  await assert.rejects(() => saveImageAttachment(session(), huge), /too large/);
});

test("reading an image id that was never saved returns undefined, not a throw", async () => {
  assert.equal(await readImageDataUri(session(), "0000000000000000", "image/png"), undefined);
});

test("a data attachment is saved and read back verbatim", async () => {
  const sid = session();
  const text = "Group\tScore\nA\t1\nB\t2\n";
  const saved = await saveDataAttachment(sid, text);
  assert.equal(saved.bytes, Buffer.byteLength(text, "utf8"));
  assert.equal(await readDataText(sid, saved.id), text);
});

test("a data attachment over the size ceiling is refused", async () => {
  await assert.rejects(() => saveDataAttachment(session(), "x".repeat(9 * 1024 * 1024)), /too large/);
});

test("reading a data id that was never saved returns undefined, not a throw", async () => {
  assert.equal(await readDataText(session(), "0000000000000000"), undefined);
});

test("an id that is not a plain attachment id resolves to undefined, never joined onto a path", async () => {
  // assertAttachmentId throws for a path-shaped id, but readDataText/
  // readImageDataUri catch that the same way they catch a missing file --
  // "not a valid reference" degrades exactly like "no longer there" does,
  // rather than failing the whole request.
  assert.equal(await readDataText(session(), "../secrets"), undefined);
  assert.equal(await readImageDataUri(session(), "../../etc/passwd", "image/png"), undefined);
});

test("deleting an attachment makes it unreadable, and deleting twice is not an error", async () => {
  const sid = session();
  const saved = await saveDataAttachment(sid, "a\tb\n1\t2\n");
  await deleteAttachment(sid, saved.id);
  assert.equal(await readDataText(sid, saved.id), undefined);
  await deleteAttachment(sid, saved.id); // already gone -- must not throw
});

test("a session's image and data attachments get distinct ids and both resolve", async () => {
  // The two kinds share one directory and one filesByPrefix listing, keyed
  // by id alone -- proving they do not collide with each other.
  const sid = session();
  const img = await saveImageAttachment(sid, PNG);
  const data = await saveDataAttachment(sid, "x\ty\n1\t2\n");
  assert.notEqual(img.id, data.id);
  assert.ok((await readImageDataUri(sid, img.id, img.mime))?.length);
  assert.ok((await readDataText(sid, data.id))?.length);
});

test("deleteSessionAttachments removes everything a conversation held", async () => {
  const sid = session();
  const saved = await saveDataAttachment(sid, "a\tb\n1\t2\n");
  await deleteSessionAttachments(sid);
  assert.equal(await readDataText(sid, saved.id), undefined);
});
