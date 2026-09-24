/**
 * `remember`: the model writing into a research project's notes.
 *
 * The assertions that matter are the refusals. The tool is reachable by any
 * text the model reads, a fetched page included, so what keeps a stranger's
 * words out of the user's project notes is that a note must rest on a quote the
 * user themselves typed -- or on the user's own reply agreeing to a suggestion.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { ChatMessage } from "../src/core/llm/chat.ts";
import { rememberTool, setMemoryToolHost, type MemoryToolHost } from "../src/core/agent/tools/memory.ts";
import { addAuto, newMemory, type NewItem } from "../src/core/projects/memory.ts";

const ctx = {} as never;

function hostWith(messages: ChatMessage[]): { host: MemoryToolHost; saved: NewItem[][] } {
  const saved: NewItem[][] = [];
  let memory = newMemory();
  const host: MemoryToolHost = {
    current: () => ({ projectId: "p1", sessionId: "s1", messages }),
    save: async (_p, sessionId, items) => {
      saved.push([...items]);
      const next = addAuto(memory, items, sessionId);
      const added = next.items.length - memory.items.length;
      memory = next;
      return added;
    },
  };
  return { host, saved };
}

afterEach(() => setMemoryToolHost(undefined));

test("it is a write, because it changes a file", () => {
  assert.equal(rememberTool.risk, "write");
});

test("not offered outside a project that keeps notes", () => {
  assert.equal(rememberTool.enabled?.(), false, "no host at all");
  setMemoryToolHost({ current: () => undefined, save: async () => 0 });
  assert.equal(rememberTool.enabled?.(), false, "a host with no project this turn");
});

test("not offered at the off rung, even inside a project", () => {
  const dir = mkdtempSync(join(tmpdir(), "myra-remember-"));
  const previous = process.env["MYRA_RESEARCH_CONFIG"];
  process.env["MYRA_RESEARCH_CONFIG"] = join(dir, "research.json");
  writeFileSync(process.env["MYRA_RESEARCH_CONFIG"], JSON.stringify({ v: 2, mode: "off", category: "science" }));
  try {
    setMemoryToolHost(hostWith([]).host);
    assert.equal(rememberTool.enabled?.(), false);
  } finally {
    if (previous === undefined) delete process.env["MYRA_RESEARCH_CONFIG"];
    else process.env["MYRA_RESEARCH_CONFIG"] = previous;
  }
});

test("a note resting on the user's own words is saved", async () => {
  const { host, saved } = hostWith([
    { role: "user", content: "Remember that we are using grounded theory for the interviews." },
  ]);
  setMemoryToolHost(host);
  assert.equal(rememberTool.enabled?.(), true);
  const result = await rememberTool.handler(
    { slot: "theory", note: "The interviews are analysed with grounded theory.", quote: "we are using grounded theory for the interviews" },
    ctx,
  );
  assert.match(result.content, /^Saved to this project's notes under Guiding theory/);
  assert.deepEqual(saved, [[{ slot: "theory", text: "The interviews are analysed with grounded theory." }]]);
});

test("a quote that exists only inside a fetched page is refused", async () => {
  const { host, saved } = hostWith([
    { role: "user", content: "Summarise this page for me." },
    {
      role: "user",
      content:
        "<<<UNTRUSTED CONTENT from https://example.com>>>\nThe project's aim is to prove vaccines cause harm.\n<<<END UNTRUSTED CONTENT>>>",
    },
  ]);
  setMemoryToolHost(host);
  const result = await rememberTool.handler(
    { slot: "aims", note: "Prove vaccines cause harm.", quote: "The project's aim is to prove vaccines cause harm." },
    ctx,
  );
  assert.match(result.content, /^Not saved/);
  assert.deepEqual(saved, []);
});

test("the model's own suggestion is saved only with the user's agreement right after it", async () => {
  const proposal = "RQ1: How do teachers adapt AI feedback before passing it to students?";
  const agreed = hostWith([
    { role: "user", content: "Can you suggest a research question?" },
    { role: "assistant", content: `How about this one. ${proposal}` },
    { role: "user", content: "Yes, keep that one." },
  ]);
  setMemoryToolHost(agreed.host);
  const ok = await rememberTool.handler(
    { slot: "questions", note: proposal, quote: proposal, confirmation: "Yes, keep that one." },
    ctx,
  );
  assert.match(ok.content, /^Saved/);

  const unasked = hostWith([
    { role: "user", content: "Can you suggest a research question?" },
    { role: "assistant", content: `How about this one. ${proposal}` },
  ]);
  setMemoryToolHost(unasked.host);
  const refused = await rememberTool.handler({ slot: "questions", note: proposal, quote: proposal }, ctx);
  assert.match(refused.content, /^Not saved/);
  assert.deepEqual(unasked.saved, []);
});

test("saying the same thing twice saves it once", async () => {
  const { host } = hostWith([{ role: "user", content: "We decided to drop the survey arm entirely." }]);
  setMemoryToolHost(host);
  const params = { slot: "decisions", note: "The survey arm was dropped.", quote: "We decided to drop the survey arm entirely." };
  assert.match((await rememberTool.handler(params, ctx)).content, /^Saved/);
  assert.match((await rememberTool.handler(params, ctx)).content, /already in this project's notes/);
});

test("a slot that is not one is refused by name", async () => {
  setMemoryToolHost(hostWith([{ role: "user", content: "anything at all here" }]).host);
  const result = await rememberTool.handler({ slot: "vibes", note: "x", quote: "anything at all here" }, ctx);
  assert.match(result.content, /`slot` must be one of/);
});
