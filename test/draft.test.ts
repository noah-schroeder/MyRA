/**
 * The draft flow.
 *
 * Two things are worth testing here and they are different in kind. The outline
 * is a document the user edits by hand, so its round trip has to survive
 * whatever they type -- reordering, renumbering, deleting a section, changing
 * the format. The flow itself is an orchestration, and what matters about it is
 * the order and the boundaries: that nothing is written before approval, that
 * the EDITED outline is the one that gets written, that each section is a
 * separate request, and that the file exists on disk before the last one
 * finishes.
 */

import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  MAX_SECTION_WORDS, OutlineError, parseOutline, renderOutline, totalWords, type Outline,
} from "../src/core/documents/outline.ts";
import {
  assemble, buildSectionPrompt, citationsIn, cleanSection, DraftCancelled, FELL_BACK_NOTICE,
  outlineFromReply, runDraft,
} from "../src/core/documents/draft.ts";
import { setEndpointResolver } from "../src/core/llm/chat.ts";

const OUTLINE: Outline = {
  title: "Working memory training",
  audience: "the funding committee",
  filename: "wm-training.md",
  format: "md",
  sections: [
    { heading: "Introduction", brief: "Why this matters now.", words: 300 },
    { heading: "Evidence", brief: "What the trials found.", words: 500 },
    { heading: "Conclusion", brief: "What we recommend.", words: 200 },
  ],
};

/* ---------------------------------------------------------- the outline --- */

test("an outline survives the round trip through the editor untouched", () => {
  assert.deepEqual(parseOutline(renderOutline(OUTLINE), OUTLINE), OUTLINE);
});

test("the rendered instructions do not come back as a section", () => {
  // renderOutline writes two lines of guidance under ## Sections, before the
  // first ### heading. Anything that collected them would turn the help text
  // into a section of the finished document.
  const parsed = parseOutline(renderOutline(OUTLINE), OUTLINE);
  assert.equal(parsed.sections.length, 3);
  assert.equal(parsed.sections[0]!.heading, "Introduction");
});

test("hand-numbered headings do not carry their numbers into the document", () => {
  // Someone reordering sections by hand leaves the old numbers behind. Baking
  // "3." into a heading that is now second is worse than having no numbers.
  const text = renderOutline(OUTLINE).replace("### Introduction", "### 3. Introduction");
  assert.equal(parseOutline(text, OUTLINE).sections[0]!.heading, "Introduction");
});

test("a deleted section is dropped, and a hand-written one is picked up", () => {
  const text = renderOutline(OUTLINE)
    .replace(/### Evidence\nwords: 500\nWhat the trials found\.\n/, "")
    + "\n### Costs\nwords: 250\nWhat it would take to run.\n";
  const parsed = parseOutline(text, OUTLINE);
  assert.deepEqual(parsed.sections.map((s) => s.heading), ["Introduction", "Conclusion", "Costs"]);
  assert.equal(parsed.sections[2]!.words, 250);
});

test("a section with no sections at all is refused, not silently emptied", () => {
  const text = renderOutline(OUTLINE).replace(/### [\s\S]*$/, "");
  assert.throws(() => parseOutline(text, OUTLINE), OutlineError);
});

test("a nonsense length is reported against the section it is in", () => {
  const text = renderOutline(OUTLINE).replace("words: 500", "words: lots");
  assert.throws(() => parseOutline(text, OUTLINE), /Evidence.*positive number/s);
});

test("a section longer than the flow will write is capped, not rejected", () => {
  // Capped rather than refused because the number is advisory: the user meant
  // "long", and failing the dialog over it would be pedantry.
  const text = renderOutline(OUTLINE).replace("words: 500", "words: 99999");
  assert.equal(parseOutline(text, OUTLINE).sections[1]!.words, MAX_SECTION_WORDS);
});

test("changing the format renames the file to match it", () => {
  // The mismatch this prevents is only discovered when the file is emailed:
  // Markdown inside something called .md, described everywhere as a Word file.
  const text = renderOutline(OUTLINE).replace("format: md", "format: docx");
  const parsed = parseOutline(text, OUTLINE);
  assert.equal(parsed.format, "docx");
  assert.equal(parsed.filename, "wm-training.docx");
});

test("a filename that climbs out of the documents folder is refused", () => {
  for (const bad of ["../escape.md", "/etc/passwd", "../../x"]) {
    const text = renderOutline(OUTLINE).replace("name: wm-training.md", `name: ${bad}`);
    assert.throws(() => parseOutline(text, OUTLINE), OutlineError, `${bad} must be refused`);
  }
});

test("an unknown format is refused with the list of real ones", () => {
  const text = renderOutline(OUTLINE).replace("format: md", "format: wordperfect");
  assert.throws(() => parseOutline(text, OUTLINE), /unknown format/i);
});

test("totalWords adds up what the user approved", () => {
  assert.equal(totalWords(OUTLINE), 1000);
});

/* ------------------------------------------------- the model's proposal --- */

test("a sparse model reply still becomes an editable outline", () => {
  const { outline, fellBack } = outlineFromReply({ sections: [{ heading: "One" }] }, "write me a thing");
  assert.equal(outline.sections[0]!.words, 300, "a missing length gets a default");
  assert.equal(outline.title, "write me a thing");
  assert.ok(outline.filename.endsWith(".md"));
  assert.equal(fellBack, false, "one real section is a plan, not a fallback");
});

test("a reply with no usable sections is an outline, not an error — and says so", () => {
  // The user is about to see this in a dialog. A one-section outline can be
  // edited into shape; an exception cannot. But shown without comment it is
  // indistinguishable from a model that decided one section was enough, and
  // the user would approve it and get exactly what they were shown.
  const { outline, fellBack } = outlineFromReply({ title: "T", sections: [{ brief: "no heading" }, 7] }, "req");
  assert.equal(outline.sections.length, 1);
  assert.equal(outline.sections[0]!.heading, "T");
  assert.equal(fellBack, true);
});

test("a placeholder outline is labelled as one in the dialog, and the label does not survive", () => {
  const { outline } = outlineFromReply({}, "req");
  const rendered = renderOutline(outline, FELL_BACK_NOTICE);
  assert.match(rendered, /did not return a usable plan/);
  // Everything above the first ## is dropped on the way back, so the notice
  // cannot end up inside the document it is warning about.
  assert.doesNotMatch(JSON.stringify(parseOutline(rendered, outline)), /usable plan/);
});

test("the planner is told a brief is an instruction, not the section", async () => {
  /* Watching the planner stream, a 2.6B spent most of its reasoning deciding
     whether "brief" meant a summary or the full text, and concluded it should
     "embed the full report text within the sections" -- which would defeat the
     split the whole flow exists for. */
  const { buildOutlinePrompt } = await import("../src/core/documents/draft.ts");
  const p = buildOutlinePrompt("a report on X");
  assert.match(p, /table of contents, not the document/);
  assert.match(p, /ONE sentence/);
  assert.match(p, /not the section itself/);
});

/* --------------------------------------------------- section generation --- */

test("a section prompt says which section it is, and what came before", () => {
  const p = buildSectionPrompt(OUTLINE, 1, "…and that is where the field stood in 2019.");
  assert.match(p, /Evidence {3}<- write this one/);
  assert.match(p, /that is where the field stood in 2019/);
  assert.match(p, /the funding committee/);
  // The other headings are present so the section does not re-introduce or
  // conclude the document; their bodies are not, so this stays bounded.
  assert.match(p, /Introduction/);
  assert.match(p, /Conclusion/);
});

test("citation shapes a model actually invents are caught", () => {
  // The first two are verbatim what LFM2.5-2.6B produced on the first real run
  // of this flow, before anything told it not to.
  assert.deepEqual(citationsIn("meta-analyses by Melby-Lervaag and colleagues (2016) report"),
    ["Melby-Lervaag and colleagues (2016)"]);
  assert.deepEqual(citationsIn("and by Jaeggi et al. (2010) found"), ["Jaeggi et al. (2010)"]);
  assert.deepEqual(citationsIn("as shown elsewhere (Smith, 2020)"), ["(Smith, 2020)"]);
  assert.deepEqual(citationsIn("two groups (Smith & Jones, 2019) agreed"), ["(Smith & Jones, 2019)"]);
  assert.deepEqual(citationsIn("supported by evidence [3]"), ["[3]"]);
  assert.deepEqual(citationsIn("several sources [1, 2] agree"), ["[1, 2]"]);
  assert.deepEqual(citationsIn("see doi:10.1234/abc.5678 for more"), ["doi:10.1234/abc.5678"]);
});

test("ordinary prose is not flagged as a citation", () => {
  /* A warning that fires on dates trains the user to ignore it, which is worse
     than no warning: the one real fabrication then scrolls past unread. */
  for (const clean of [
    "the trials ran until 2019 and were not replicated",
    "recruitment closed in March (2019) after a year",
    "working memory (WM) training is widely sold",
    "the effect was small (see the discussion above)",
    "a 2016 review and a 2010 trial disagreed",
  ]) {
    assert.deepEqual(citationsIn(clean), [], `must not flag: ${clean}`);
  }
});

test("an invented citation is reported rather than quietly stripped", async () => {
  /* Not repaired, deliberately. The document is on disk before this is known --
     it is written a section at a time on purpose -- and removing a marker would
     leave its sentence reading as the writer's own established fact, which is
     the more dangerous of the two states. */
  replies = [PROPOSAL, "As Jaeggi et al. (2010) showed, the effect is small.", "Clean prose here."];
  const h = harness((p) => p);
  const result = await runDraft(h.opts);

  assert.equal(result.invented.length, 1);
  assert.equal(result.invented[0]!.heading, "Introduction");
  assert.deepEqual(result.invented[0]!.found, ["Jaeggi et al. (2010)"]);
  // Still in the document: the user is told, not silently edited.
  assert.match(result.markdown, /Jaeggi et al\. \(2010\)/);
  assert.ok(h.notes.some((n) => /invented 1 citation/.test(n)), h.notes.join(" | "));
});

test("a clean draft reports nothing to worry about", async () => {
  replies = [PROPOSAL, "Plain prose.", "More plain prose."];
  const h = harness((p) => p);
  assert.deepEqual((await runDraft(h.opts)).invented, []);
});

test("every section is told it has no sources, because nothing here has any", () => {
  /* The one instruction that cannot be left to the system prompt: runSubagent
     sends only the system string it is given, and this stage gives none. Asked
     for an academic tone without this, a 2.6B invented two plausible
     author-year citations in its first real run. */
  const p = buildSectionPrompt(OUTLINE, 0, "");
  assert.match(p, /You have no sources/);
  assert.match(p, /do not\n    cite/);
});

test("the first section is told it is first, rather than given an empty quote", () => {
  const p = buildSectionPrompt(OUTLINE, 0, "");
  assert.match(p, /This is the first section/);
  assert.doesNotMatch(p, /THE PREVIOUS SECTION ENDED/);
});

test("a repeated heading is stripped, and a real sub-heading is kept", () => {
  assert.equal(cleanSection("## Evidence\n\nThe trials found…", "Evidence"), "The trials found…");
  assert.equal(cleanSection("Evidence\n\nThe trials found…", "Evidence"), "The trials found…");
  assert.equal(
    cleanSection("The trials found…\n\n### Subgroups\n\nMore.", "Evidence"),
    "The trials found…\n\n### Subgroups\n\nMore.",
  );
});

test("a section that has not been written yet is marked, not omitted", () => {
  // A partial save that silently skipped it would read as a finished document
  // that simply had nothing to say about the middle.
  const md = assemble(OUTLINE, ["one"]);
  assert.match(md, /## Evidence\n\n\*\(not yet written\)\*/);
  assert.match(md, /# Working memory training/);
});

/* ------------------------------------------------------------ the flow --- */

/** What the stub model says next. Shifted per request. */
let replies: string[] = [];
let prompts: string[] = [];
let server: Server;
let baseUrl = "";

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body) as { messages: { content: string }[]; stream?: boolean };
      prompts.push(parsed.messages[parsed.messages.length - 1]!.content);
      const content = replies.shift() ?? "(no reply queued)";

      /* Both shapes, chosen by the request, because the flow uses both: the
         draft stages pass an onDelta so the user can see the model working,
         which switches chat() to SSE. A stub that only spoke JSON would pass
         while testing a code path the app never takes. */
      if (!parsed.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Split across frames so a parser that only handles whole replies fails.
      for (const chunk of content.match(/[\s\S]{1,20}/g) ?? []) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  setEndpointResolver(async () => ({
    endpoint: { baseUrl, envVar: "KAREN_LLM_KEY", timeoutMs: 10_000 },
  }));
});

after(async () => {
  setEndpointResolver(undefined);
  await new Promise<void>((r) => server.close(() => r()));
});

const PROPOSAL = JSON.stringify({
  title: "Working memory training",
  audience: "the funding committee",
  sections: [
    { heading: "Introduction", brief: "Why now.", words: 300 },
    { heading: "Evidence", brief: "The trials.", words: 500 },
  ],
});

function harness(edit: (proposed: string) => string | undefined) {
  const saves: { markdown: string; final: boolean }[] = [];
  const notes: string[] = [];
  let shown = "";
  return {
    saves, notes, shown: () => shown,
    opts: {
      request: "a case for funding working memory training",
      model: "stub",
      ui: {
        editor: async (_title: string, prefill?: string) => {
          shown = prefill ?? "";
          return edit(shown);
        },
      },
      save: async (markdown: string, o: { final: boolean }) => {
        saves.push({ markdown, final: o.final });
        return "/documents/wm-training.md";
      },
      onProgress: (n: string) => notes.push(n),
    },
  };
}

test("nothing is written when the outline is not approved", async () => {
  replies = [PROPOSAL];
  const h = harness(() => undefined);
  await assert.rejects(() => runDraft(h.opts), DraftCancelled);
  // The whole reason the dialog comes before the writing.
  assert.equal(h.saves.length, 0);
  assert.match(h.shown(), /# Draft plan/);
  assert.match(h.shown(), /Nothing has been written yet/);
});

test("each section is a separate request, and the file is saved after every one", async () => {
  replies = [PROPOSAL, "Working memory has been studied since…", "Six trials met the criteria…"];
  prompts = [];
  const h = harness((p) => p);
  const result = await runDraft(h.opts);

  // One planning call plus one per section: the split is the feature, so it is
  // asserted rather than inferred from the output looking plausible.
  assert.equal(prompts.length, 3);
  assert.match(prompts[1]!, /WRITE SECTION 1: Introduction/);
  assert.match(prompts[2]!, /WRITE SECTION 2: Evidence/);
  // The second section sees the tail of the first, not the whole of it.
  assert.match(prompts[2]!, /THE PREVIOUS SECTION ENDED/);

  // Saved after each section AND at the end: a run that dies at section two
  // leaves section one on disk.
  assert.equal(h.saves.length, 3);
  assert.deepEqual(h.saves.map((s) => s.final), [false, false, true]);
  assert.match(h.saves[0]!.markdown, /\*\(not yet written\)\*/);
  assert.doesNotMatch(h.saves[2]!.markdown, /\*\(not yet written\)\*/);

  assert.equal(result.outline.sections.length, 2);
  assert.match(result.markdown, /Six trials met the criteria/);
  assert.ok(result.words > 0);
});

test("the requested format reaches the outline, not just the validator", async () => {
  // Validated and then dropped, "write it as a Word document" produced a .md
  // and said nothing about it.
  replies = [PROPOSAL, "a", "b"];
  const h = harness((p) => p);
  const result = await runDraft({ ...h.opts, format: "docx" });
  assert.equal(result.outline.format, "docx");
  assert.ok(result.outline.filename.endsWith(".docx"), result.outline.filename);
});

test("the edited outline is the one that gets written, not the proposed one", async () => {
  replies = [PROPOSAL, "Only this."];
  prompts = [];
  const h = harness((p) =>
    p.replace("### Evidence\nwords: 500\nThe trials.\n", "").replace("Introduction", "Background"),
  );
  const result = await runDraft(h.opts);

  assert.deepEqual(result.outline.sections.map((s) => s.heading), ["Background"]);
  assert.equal(prompts.length, 2, "the deleted section must not be written");
  assert.match(result.markdown, /## Background/);
  assert.doesNotMatch(result.markdown, /Evidence/);
});

test("an outline edited into something unwritable fails before any writing", async () => {
  replies = [PROPOSAL];
  const h = harness((p) => p.replace(/### [\s\S]*$/, ""));
  await assert.rejects(() => runDraft(h.opts), OutlineError);
  assert.equal(h.saves.length, 0);
});

test("cancelling partway stops the run and keeps what was already saved", async () => {
  replies = [PROPOSAL, "First section text.", "Second section text."];
  const control = new AbortController();
  const h = harness((p) => p);
  const opts = {
    ...h.opts,
    signal: control.signal,
    save: async (markdown: string, o: { final: boolean }) => {
      h.saves.push({ markdown, final: o.final });
      // Abort after the first section has been persisted.
      control.abort();
      return "/documents/wm-training.md";
    },
  };
  await assert.rejects(() => runDraft(opts), DraftCancelled);
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0]!.final, false);
  assert.match(h.saves[0]!.markdown, /First section text/);
});

test("the planning stage streams, so a slow model does not look like a hung one", async () => {
  /* Measured before this: over three minutes of "planning the document…" and
     nothing else while a 2.6B thought, with no way to tell a slow model from a
     dead one. Passing an onDelta is also what makes the request stream at all,
     so the idle timeout starts meaning silence rather than total duration. */
  replies = [PROPOSAL, "a", "b"];
  const h = harness((p) => p);
  await runDraft(h.opts);
  assert.ok(
    h.notes.some((n) => /^planning… \d/.test(n)),
    `expected a streamed planning note, got: ${h.notes.join(" | ")}`,
  );
  assert.ok(h.notes.some((n) => /^Introduction… \d/.test(n)), "sections stream too");
  /* Never the model's own text. The line sits above the composer all run, and
     a JSON stage's tail put its monologue about JSON formatting there. */
  assert.ok(
    !h.notes.some((n) => n.includes("Working memory") || n.includes("{")),
    `progress must not echo model output: ${h.notes.join(" | ")}`,
  );
});

test("progress names the section being written, not just a count", async () => {
  replies = [PROPOSAL, "a", "b"];
  const h = harness((p) => p);
  await runDraft(h.opts);
  assert.ok(h.notes.some((n) => /writing 1 of 2: Introduction/.test(n)), h.notes.join(" | "));
  assert.ok(h.notes.some((n) => /writing 2 of 2: Evidence/.test(n)));
});
