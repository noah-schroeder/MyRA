/**
 * Browsing the registry directly.
 *
 * The tests that matter are about the query string, because the difference
 * between `author=` and `search=` is the difference between a publisher's
 * page and a guess -- and that difference is what this whole module exists
 * for. "granite" through the old path returned 42 rows of which 5 were
 * usable; `author=ibm-granite` returns the publisher's actual catalogue.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  age,
  browsableKinds,
  browseParams,
  compact,
  describeDownloads,
  KINDS,
  kindById,
  loadable,
  loadableFiles,
  mergeSorted,
  parseModels,
  pullCheckpoint,
  pullName,
  recipeFor,
  SORTS,
  type HfModel,
} from "../src/core/runtime/hfBrowse.ts";

const get = (q: Parameters<typeof browseParams>[0]) => browseParams(q);

/* ------------------------------------------------------------- params -- */

test("a publisher is asked for exactly, not matched by name", () => {
  const p = get({ author: "ibm-granite" });
  assert.equal(p.get("author"), "ibm-granite");
  assert.equal(p.get("search"), null);
});

test("free text and a publisher can be combined", () => {
  const p = get({ author: "unsloth", query: "qwen" });
  assert.equal(p.get("author"), "unsloth");
  assert.equal(p.get("search"), "qwen");
});

test("a model kind becomes a pipeline tag the API understands", () => {
  assert.equal(get({ kind: "image" }).get("pipeline_tag"), "text-to-image");
  assert.equal(get({ kind: "chat" }).get("pipeline_tag"), "text-generation");
});

test("the everything tab sets no tag at all", () => {
  // A tab that filtered client-side would report counts over a page it had
  // already truncated, so "everything" has to mean "no filter sent".
  assert.equal(get({ kind: "all" }).get("pipeline_tag"), null);
});

test("nothing is filtered to GGUF unless it was asked for", () => {
  // The complaint that started this: a publisher's 42 repositories showing as
  // 5, because only 5 held GGUF. Showing everything is now the default.
  assert.equal(get({ author: "ibm-granite" }).get("filter"), null);
  assert.equal(get({ author: "ibm-granite", ggufOnly: true }).get("filter"), "gguf");
});

test("the GGUF filter is not applied to kinds that do not read GGUF", () => {
  /* sd-cpp reads .safetensors, whisper.cpp reads ggml .bin, kokoro reads
     .onnx. Filtering those tabs to `gguf` hides exactly the models that work
     -- stabilityai/sd-turbo among them. */
  assert.equal(get({ kind: "image", ggufOnly: true }).get("filter"), null);
  assert.equal(get({ kind: "speech", ggufOnly: true }).get("filter"), null);
  assert.equal(get({ kind: "voice", ggufOnly: true }).get("filter"), null);
  // And still applied where it means something.
  assert.equal(get({ kind: "chat", ggufOnly: true }).get("filter"), "gguf");
  assert.equal(get({ kind: "vision", ggufOnly: true }).get("filter"), "gguf");
});

test("a full page is asked for, not a handful", () => {
  assert.equal(get({}).get("limit"), "100");
});

test("the fields the rows display are requested explicitly", () => {
  // The default response omits downloads, which is the one number on a row a
  // person can act on.
  const expanded = get({}).getAll("expand[]");
  for (const field of ["downloads", "likes", "createdAt", "pipeline_tag"]) {
    assert.ok(expanded.includes(field), field);
  }
});

test("every offered sort is a real one, and downloads is the default", () => {
  assert.equal(get({}).get("sort"), "downloads");
  for (const s of SORTS) assert.equal(get({ sort: s.id }).get("sort"), s.id);
});

test("an unknown kind falls back to everything rather than throwing", () => {
  assert.equal(kindById("nonsense").id, "all");
});

/* -------------------------------------------------------------- parse -- */

test("the API's rows become models, and malformed ones are skipped", () => {
  const models = parseModels([
    {
      id: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF",
      downloads: 12_760_676,
      likes: 933,
      pipeline_tag: "text-generation",
      tags: ["gguf", "qwen3"],
      createdAt: "2025-07-31T10:27:38.000Z",
    },
    { nonsense: true },
    null,
  ]);
  assert.equal(models.length, 1);
  assert.equal(models[0]!.owner, "unsloth");
  assert.equal(models[0]!.hasGguf, true);
  assert.equal(models[0]!.downloads, 12_760_676);
});

test("a repository without the gguf tag is not claimed to have one", () => {
  const [model] = parseModels([{ id: "ibm-granite/granite-4.1-8b", tags: ["transformers"] }]);
  assert.equal(model!.hasGguf, false);
});

test("a gated repository is marked, because it will not download unprompted", () => {
  const [a] = parseModels([{ id: "meta-llama/x", gated: "auto", tags: [] }]);
  const [b] = parseModels([{ id: "open/y", tags: [] }]);
  assert.equal(a!.gated, true);
  assert.equal(b!.gated, false);
});

/* ----------------------------------------------------------- loadable -- */

const model = (patch: Partial<HfModel> = {}): HfModel => ({
  id: "a/b", owner: "a", tags: [], hasGguf: true, gated: false, ...patch,
});

const INSTALLED = new Set(["llamacpp"]);

test("a GGUF chat model with its engine installed is ready", () => {
  assert.equal(loadable(model(), "llamacpp", INSTALLED), "ready");
});

test("original weights are named as the wrong format rather than as a failure", () => {
  // 37 of the 42 granite results were this. It is not an error, it is a
  // repository holding the unquantised model.
  assert.equal(loadable(model({ hasGguf: false }), "llamacpp", INSTALLED), "wrong-format");
});

test("a speech model needs an engine rather than being impossible", () => {
  /* It used to read "cannot run", which was wrong: the engine is one click
     away under Settings → Runtime. */
  assert.equal(loadable(model(), "kokoro", INSTALLED), "needs-engine");
  assert.equal(loadable(model(), "whispercpp", INSTALLED), "needs-engine");
});

test("once its engine is installed a speech model is ready", () => {
  assert.equal(loadable(model(), "whispercpp", new Set(["llamacpp", "whispercpp"])), "ready");
});

test("the format test applies only to llama.cpp, which is the one reading GGUF", () => {
  // whisper.cpp reads ggml `.bin`, so "no gguf tag" says nothing about it.
  const weights = model({ hasGguf: false });
  assert.equal(loadable(weights, "whispercpp", new Set(["whispercpp"])), "ready");
});

test("with no engine list yet, a row is not accused of needing anything", () => {
  // Before system-info arrives, claiming an engine is missing would be a guess.
  assert.equal(loadable(model(), "whispercpp"), "ready");
});

/*
 * A diffusion model is the one kind search does not offer, whatever is
 * installed.
 *
 * Not a judgement about the engine or the format: sd-cpp may be installed and
 * the repository may hold a perfectly good safetensors, and the download still
 * cannot work, because the text encoder and VAE it needs are in repositories
 * nothing here names. Asserted against both engines and both engine states so
 * that "install sd-cpp and it becomes downloadable" cannot creep back.
 */
test("a diffusion model is curated-only however the machine is set up", () => {
  for (const recipe of ["sd-cpp", "thenoise"]) {
    assert.equal(loadable(model(), recipe, INSTALLED), "curated-only");
    assert.equal(loadable(model(), recipe, new Set(["llamacpp", recipe])), "curated-only");
    assert.equal(loadable(model({ hasGguf: false }), recipe), "curated-only");
  }
});

test("the image kind is not offered as a search tab", () => {
  assert.ok(KINDS.some((k) => k.id === "image"), "the kind itself still exists");
  assert.ok(!browsableKinds().some((k) => k.id === "image"));
  // Everything else still is, so this narrowed one thing rather than the list.
  assert.equal(browsableKinds().length, KINDS.length - 1);
});

/* ------------------------------------------------------------ wording -- */

test("the download figure carries the window it was measured over", () => {
  assert.equal(describeDownloads(12_760_676), "12.8M in the last 30 days");
  assert.equal(describeDownloads(undefined), "Not reported");
});

test("counts are compact without being wrong", () => {
  assert.equal(compact(12_760_676), "12.8M");
  assert.equal(compact(92_613_063), "92.6M");
  assert.equal(compact(1_000_000), "1M");
  assert.equal(compact(334_000), "334k");
  assert.equal(compact(undefined), "—");
});

test("age reads as a person would say it", () => {
  const now = Date.parse("2026-08-30T12:00:00Z");
  assert.equal(age("2026-08-30T06:00:00Z", now), "today");
  assert.equal(age("2026-08-26T12:00:00Z", now), "4 days ago");
  assert.equal(age("2026-06-25T12:00:00Z", now), "2 months ago");
  assert.equal(age(undefined, now), undefined);
  assert.equal(age("not a date", now), undefined);
});

test("every kind now has an engine that runs it", () => {
  /* All of these used to be marked unrunnable, which was a gap in MyRA
     rather than a fact about the models: naming the right recipe on the pull
     makes them work. */
  const byId = new Map(KINDS.map((k) => [k.id, k]));
  for (const id of ["chat", "vision", "embedding", "image", "voice", "speech"]) {
    assert.equal(byId.get(id)!.runnable, true, id);
  }
});

test("every kind maps to a recipe the daemon actually has", () => {
  /* Measured against the daemon's own recipe list. A name it does not know is
     refused with "Recipe 'x' not found", so a typo here would break the
     download rather than degrade it. */
  const REAL = new Set([
    "llamacpp", "whispercpp", "kokoro", "sd-cpp", "moonshine",
    "acestep", "vllm", "ryzenai-llm", "flm", "onnxruntime",
  ]);
  for (const kind of KINDS) {
    if (kind.id === "all") continue;
    const recipe = recipeFor(model({ task: undefined }), kind);
    assert.ok(REAL.has(recipe), `${kind.id} -> ${recipe}`);
  }
});

/* ------------------------------------------------------------ merging -- */

test("several publishers are merged and re-sorted, not concatenated", () => {
  /* The registry answers about one `author` at a time -- `author=a&author=b`
     and `author=a,b` both return zero rows, measured -- so two publishers are
     two requests. Concatenating them would put every Unsloth model above every
     IBM one whatever the figure being sorted on. */
  const unsloth = [
    model({ id: "unsloth/a", downloads: 500 }),
    model({ id: "unsloth/b", downloads: 100 }),
  ];
  const ibm = [
    model({ id: "ibm-granite/c", downloads: 900 }),
    model({ id: "ibm-granite/d", downloads: 300 }),
  ];
  assert.deepEqual(
    mergeSorted([unsloth, ibm], "downloads").map((m) => m.id),
    ["ibm-granite/c", "unsloth/a", "ibm-granite/d", "unsloth/b"],
  );
});

test("merging sorts by whichever figure was chosen", () => {
  const pages = [[model({ id: "a/x", downloads: 900, likes: 1 })], [model({ id: "b/y", downloads: 1, likes: 900 })]];
  assert.deepEqual(mergeSorted(pages, "likes").map((m) => m.id), ["b/y", "a/x"]);
  assert.deepEqual(mergeSorted(pages, "downloads").map((m) => m.id), ["a/x", "b/y"]);
});

test("a repository published under two selected owners appears once", () => {
  const same = model({ id: "unsloth/a", downloads: 5 });
  assert.equal(mergeSorted([[same], [same]], "downloads").length, 1);
});

test("recently updated merges on the date, not on the page it came from", () => {
  const old_ = model({ id: "a/old", lastModified: "2024-01-01T00:00:00.000Z" });
  const recent = model({ id: "b/new", lastModified: "2026-08-30T00:00:00.000Z" });
  assert.deepEqual(
    mergeSorted([[old_], [recent]], "lastModified").map((m) => m.id),
    ["b/new", "a/old"],
  );
});

test("lastModified is requested, or a merged date sort would have nothing to sort on", () => {
  assert.ok(browseParams({}).getAll("expand[]").includes("lastModified"));
});
