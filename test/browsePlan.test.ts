/**
 * What a selection of publishers and filters actually asks the registry.
 *
 * Two of these were reported as the page being wrong rather than as bugs.
 *
 * **Publishers unioned when they should cross.** "IBM (Granite) and Unsloth"
 * can only mean one thing -- Unsloth's builds of Granite -- and the old code
 * made one request per author and merged them, so it answered with everything
 * IBM publishes *plus* everything Unsloth publishes. The registry expresses the
 * intended question perfectly well: `author=unsloth&search=granite`, measured
 * returning `unsloth/granite-4.1-30b-GGUF` first.
 *
 * **Uploaded-when and downloaded-how-much could not be asked at all.** The
 * registry sorts by both and filters by neither, so those two are the only
 * controls on the page applied to the answer rather than to the question --
 * which the screen has to admit, or a filter that empties a list looks like a
 * registry that holds nothing.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  applyLocalFilter, browsePlan, browseParams, describeFiltered, MAX_REQUESTS,
  splitPublishers, type HfModel,
} from "../src/core/runtime/hfBrowse.ts";

const model = (id: string, over: Partial<HfModel> = {}): HfModel => ({
  id, owner: id.split("/")[0] ?? "", tags: [], hasGguf: true, gated: false, ...over,
});

const days = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

describe("which requests a selection makes", () => {
  it("crosses a maker with a builder, because that is the only reading", () => {
    const plan = browsePlan({ authors: ["ibm-granite", "unsloth"] });
    assert.equal(plan.crossed, true);
    assert.deepEqual(
      plan.requests.map((r) => [r.author, r.query]),
      [["unsloth", "granite"]],
    );
  });

  it("searches for the family name, not the publisher's handle", () => {
    /* `search=ibm-granite` matches almost nothing: Unsloth does not put IBM's
       handle in its repository names. */
    const [request] = browsePlan({ authors: ["ibm-granite", "unsloth"] }).requests;
    assert.equal(request?.query, "granite");
    assert.equal(browseParams(request ?? {}).get("search"), "granite");
    assert.equal(browseParams(request ?? {}).get("author"), "unsloth");
  });

  it("keeps the typed words as well, instead of throwing them away", () => {
    const plan = browsePlan({ authors: ["ibm-granite", "unsloth"], query: "3.3" });
    assert.equal(plan.requests[0]?.query, "granite 3.3");
  });

  it("still unions two makers, or two builders", () => {
    const makers = browsePlan({ authors: ["ibm-granite", "Qwen"] });
    assert.equal(makers.crossed, false);
    assert.deepEqual(makers.requests.map((r) => r.author), ["ibm-granite", "Qwen"]);

    const builders = browsePlan({ authors: ["unsloth", "bartowski"] });
    assert.equal(builders.crossed, false);
    assert.deepEqual(builders.requests.map((r) => r.author), ["unsloth", "bartowski"]);
  });

  it("asks one request per pair when several of each are chosen", () => {
    const plan = browsePlan({ authors: ["ibm-granite", "Qwen", "unsloth", "bartowski"] });
    assert.deepEqual(
      plan.requests.map((r) => `${r.author ?? ""}:${r.query ?? ""}`).sort(),
      ["bartowski:granite", "bartowski:qwen", "unsloth:granite", "unsloth:qwen"].sort(),
    );
  });

  it("refuses to fan out without limit, and says how much it dropped", () => {
    /* Every request is a round trip to a service that rate-limits, and forty of
       them for one press is both slow and rude. */
    const many = browsePlan({
      authors: ["Qwen", "google", "meta-llama", "mistralai", "microsoft", "ibm-granite",
        "unsloth", "bartowski"],
    });
    assert.equal(many.requests.length, MAX_REQUESTS);
    assert.ok(many.dropped > 0);
  });

  it("asks once, with no author, when nothing is chosen", () => {
    const plan = browsePlan({ query: "qwen" });
    assert.deepEqual(plan.requests.map((r) => [r.author, r.query]), [[undefined, "qwen"]]);
  });

  it("carries the kind, sort and GGUF switch onto every request", () => {
    const plan = browsePlan({
      authors: ["ibm-granite", "unsloth"], kind: "chat", sort: "createdAt", ggufOnly: true,
    });
    for (const request of plan.requests) {
      assert.equal(request.kind, "chat");
      assert.equal(request.sort, "createdAt");
      assert.equal(request.ggufOnly, true);
    }
  });

  it("knows which publishers are which", () => {
    const { makers, builders } = splitPublishers(["unsloth", "ibm-granite", "nobody"]);
    assert.deepEqual(makers.map((p) => p.author), ["ibm-granite"]);
    assert.deepEqual(builders.map((p) => p.author), ["unsloth"]);
  });
});

describe("sorting by when it was uploaded", () => {
  it("asks the registry for it rather than reordering a page", () => {
    assert.equal(browseParams({ sort: "createdAt" }).get("sort"), "createdAt");
  });
});

describe("the filters the registry cannot express", () => {
  const page = [
    model("a/new-and-popular", { createdAt: days(5), downloads: 50_000 }),
    model("a/new-and-quiet", { createdAt: days(5), downloads: 12 }),
    model("a/old-and-popular", { createdAt: days(900), downloads: 90_000 }),
    model("a/undated", { downloads: 70_000 }),
  ];

  it("does nothing at all when neither is set", () => {
    const out = applyLocalFilter(page, {});
    assert.equal(out.shown.length, page.length);
    assert.equal(out.hidden, 0);
  });

  it("keeps what was uploaded inside the window", () => {
    const out = applyLocalFilter(page, { withinDays: 30 });
    assert.deepEqual(out.shown.map((m) => m.id), ["a/new-and-popular", "a/new-and-quiet"]);
  });

  it("counts a missing upload date separately from a failing one", () => {
    /* Treating "no date" as "too old" is a guess, and quietly hiding a model
       because a field was absent is how a list stops being trustworthy. */
    const out = applyLocalFilter(page, { withinDays: 30 });
    assert.equal(out.undated, 1);
    assert.equal(out.hidden, 1);
  });

  it("keeps what is downloaded enough", () => {
    const out = applyLocalFilter(page, { minDownloads: 10_000 });
    assert.deepEqual(
      out.shown.map((m) => m.id),
      ["a/new-and-popular", "a/old-and-popular", "a/undated"],
    );
  });

  it("applies both together", () => {
    const out = applyLocalFilter(page, { withinDays: 30, minDownloads: 10_000 });
    assert.deepEqual(out.shown.map((m) => m.id), ["a/new-and-popular"]);
  });

  it("says nothing when there is nothing to admit", () => {
    assert.equal(describeFiltered(applyLocalFilter(page, {}), 4, {}, "downloads"), undefined);
  });

  it("names the sort that would actually find new models", () => {
    /* A "past month" filter over the hundred most-downloaded repositories is
       asking the wrong hundred, and four results would otherwise look like the
       registry's answer. */
    const note = describeFiltered(
      applyLocalFilter(page, { withinDays: 30 }), 4, { withinDays: 30 }, "downloads",
    );
    assert.match(note ?? "", /2 of the 4 the registry returned match/);
    assert.match(note ?? "", /gave no upload date/);
    assert.match(note ?? "", /Recently uploaded/);
  });

  it("drops the caveat once the sort is the right one", () => {
    const note = describeFiltered(
      applyLocalFilter(page, { withinDays: 30 }), 4, { withinDays: 30 }, "createdAt",
    );
    assert.equal(/Recently uploaded/.test(note ?? ""), false);
  });
});
