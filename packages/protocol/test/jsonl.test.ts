import { test } from "node:test";
import assert from "node:assert/strict";
import {
  JsonlSplitter,
  ProtocolError,
  encodeJsonl,
  parseJsonlLine,
} from "../src/jsonl.ts";

test("splits simple LF-delimited lines", () => {
  const s = new JsonlSplitter();
  assert.deepEqual(s.push(Buffer.from('{"a":1}\n{"b":2}\n')), ['{"a":1}', '{"b":2}']);
});

test("buffers a partial line until its newline arrives", () => {
  const s = new JsonlSplitter();
  assert.deepEqual(s.push(Buffer.from('{"a":')), []);
  assert.deepEqual(s.push(Buffer.from("1}")), []);
  assert.deepEqual(s.push(Buffer.from("\n")), ['{"a":1}']);
});

// The reason this module exists. Node's readline would split on these.
test("does NOT split on U+2028 / U+2029", () => {
  const payload = { text: "line sep para" };
  const s = new JsonlSplitter();
  const lines = s.push(Buffer.from(encodeJsonl(payload), "utf8"));
  assert.equal(lines.length, 1, "U+2028/U+2029 must not terminate a frame");
  assert.deepEqual(JSON.parse(lines[0]!), payload);
});

test("does not split on a lone CR in the middle of content", () => {
  // \r is escaped by JSON.stringify, so it survives as \\r in the wire form.
  const payload = { text: "a\rb" };
  const s = new JsonlSplitter();
  const lines = s.push(Buffer.from(encodeJsonl(payload), "utf8"));
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), payload);
});

test("tolerates CRLF terminators", () => {
  const s = new JsonlSplitter();
  assert.deepEqual(s.push(Buffer.from('{"a":1}\r\n')), ['{"a":1}']);
});

test("handles a multi-byte character split across chunk boundaries", () => {
  const full = Buffer.from('{"t":"日本語"}\n', "utf8");
  const cut = 10; // lands mid-codepoint
  const s = new JsonlSplitter();
  assert.deepEqual(s.push(full.subarray(0, cut)), []);
  const lines = s.push(full.subarray(cut));
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), { t: "日本語" });
});

test("handles surrogate pairs (emoji) across a boundary", () => {
  const full = Buffer.from('{"t":"🎉🎈"}\n', "utf8");
  const s = new JsonlSplitter();
  const out: string[] = [];
  for (const byte of full) out.push(...s.push(Buffer.from([byte])));
  assert.equal(out.length, 1);
  assert.deepEqual(JSON.parse(out[0]!), { t: "🎉🎈" });
});

test("skips blank lines", () => {
  const s = new JsonlSplitter();
  assert.deepEqual(s.push(Buffer.from('\n\n{"a":1}\n\n')), ['{"a":1}']);
});

test("emits many frames from one chunk in order", () => {
  const s = new JsonlSplitter();
  const chunk = [1, 2, 3, 4, 5].map((n) => encodeJsonl({ n })).join("");
  const lines = s.push(Buffer.from(chunk));
  assert.deepEqual(
    lines.map((l) => JSON.parse(l).n),
    [1, 2, 3, 4, 5],
  );
});

test("enforces the max line guard", () => {
  const s = new JsonlSplitter({ maxLineBytes: 32 });
  assert.throws(() => s.push(Buffer.alloc(64, 0x41)), ProtocolError);
});

test("flush returns an unterminated trailing line", () => {
  const s = new JsonlSplitter();
  s.push(Buffer.from('{"a":1}'));
  assert.equal(s.flush(), '{"a":1}');
  assert.equal(s.flush(), undefined);
});

test("parseJsonlLine reports malformed frames without throwing", () => {
  const bad = parseJsonlLine("{not json");
  assert.equal(bad.ok, false);
  assert.ok(bad.error instanceof ProtocolError);

  const good = parseJsonlLine<{ a: number }>('{"a":1}');
  assert.equal(good.ok, true);
  assert.deepEqual(good.value, { a: 1 });
});

test("encodeJsonl emits exactly one newline, at the end", () => {
  const wire = encodeJsonl({ text: "has\nnewline\tand\ttabs" });
  assert.equal(wire.split("\n").length - 1, 1);
  assert.ok(wire.endsWith("\n"));
});

test("round-trips a realistic streaming payload", () => {
  const frames = [
    { type: "agent_start" },
    { type: "message_update", delta: "Hello world" },
    { type: "tool_execution_end", result: { content: [{ type: "text", text: "ok" }] } },
    { type: "agent_end" },
  ];
  const wire = Buffer.from(frames.map(encodeJsonl).join(""), "utf8");
  const s = new JsonlSplitter();
  const got = s.push(wire).map((l) => JSON.parse(l));
  assert.deepEqual(got, frames);
});
