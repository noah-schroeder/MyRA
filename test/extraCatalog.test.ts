/**
 * The models MyRA offers that Lemonade's catalogue does not carry.
 *
 * Two things are worth pinning here and neither is the list's contents. That a
 * model added upstream replaces MyRA's copy rather than doubling it, because
 * `LEMONADE_VERSION` gets bumped and the duplicate would be silent. And that
 * every entry would survive the manual form's own validator, because the
 * one-click path registers through exactly that check -- an address typed
 * wrongly here would produce a row whose button always fails.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { MYRA_CATALOG, mergeCatalog } from "../src/core/runtime/extraCatalog.ts";
import { enabledOnly, hasChatLabel, parseCatalog, type CatalogEntry } from "../src/core/runtime/catalog.ts";
import { checkImageModel } from "../src/core/runtime/imageModel.ts";

const upstream = (id: string): CatalogEntry => ({
  id, recipe: "sd-cpp", labels: ["image"], suggested: false, source: "huggingface",
});

test("MyRA's additions are appended to upstream's catalogue", () => {
  const got = mergeCatalog([upstream("SD-Turbo")], [upstream("Extra-Thing")]);
  assert.deepEqual(got.map((e) => e.id), ["SD-Turbo", "Extra-Thing"]);
});

test("a model upstream has added wins over MyRA's copy of it", () => {
  /* The case a LEMONADE_VERSION bump creates: Lemonade ships Qwen-Image-2.1 of
     its own, and two rows for one model -- the newer of them shadowed by a
     copy frozen in MyRA -- is the failure this prevents. */
  const got = mergeCatalog([upstream("Qwen-Image-2.1")], [upstream("Qwen-Image-2.1")]);
  assert.equal(got.length, 1);
  assert.equal(got[0]?.suggested, false, "upstream's entry, not MyRA's");
});

test("an extra entry from a disabled registry is still filtered out after the merge", () => {
  /* enabledOnly's own guarantee is that the renderer never receives a
     disabled registry's entries. mergeCatalog runs after it in
     RuntimeManager.catalog(), so an extra entry has to be filtered on the
     way OUT of that composition, not only on the way in -- filtering only
     upstream's list and merging MyRA's additions in afterward would let a
     future addition from a disabled source reach the renderer with a
     working-looking Download button, regardless of how it got there. */
  const disabled = upstream("Disabled-Extra");
  disabled.source = "modelscope";
  const got = enabledOnly(mergeCatalog([upstream("SD-Turbo")], [disabled]));
  assert.deepEqual(got.map((e) => e.id), ["SD-Turbo"]);
});

test("every model MyRA adds carries the parts needed to register it", () => {
  // A row the daemon has never heard of cannot be pulled by name without these.
  for (const entry of MYRA_CATALOG) {
    assert.ok(entry.checkpoints?.["main"], `${entry.id} has no main checkpoint`);
    assert.ok(entry.sizeBytes, `${entry.id} has no size, so it gets no fit verdict`);
    assert.ok(entry.labels.length, `${entry.id} has no labels, so it lands in no group`);
  }
});

test("every model MyRA adds passes the check its own download makes", () => {
  /* The one-click path goes through `myra:register-image-model`, which runs
     `checkImageModel`. An address that fails it would ship a button that can
     only ever error. */
  for (const entry of MYRA_CATALOG) {
    const got = checkImageModel({ name: entry.id, parts: entry.checkpoints ?? {}, recipe: entry.recipe });
    assert.ok(got.ok, `${entry.id} would be refused: ${got.ok ? "" : got.error}`);
  }
});

test("hasChatLabel recognises any of the chat group's own labels, not just 'chat'", () => {
  assert.ok(hasChatLabel(["chat"]));
  assert.ok(hasChatLabel(["reasoning"]));
  assert.ok(hasChatLabel(["coding"]));
  assert.ok(hasChatLabel(["vision", "chat"]), "any matching label is enough");
  assert.ok(!hasChatLabel(["image"]));
  assert.ok(!hasChatLabel([]));
});

/* ------------------------------------------------- the plural checkpoint -- */

test("a split model's parts are read, and `main` stands in for the checkpoint", () => {
  /* Upstream writes a single-file model as `checkpoint` and a split one as
     `checkpoints`; the daemon reports both on everything. Without `main`
     filling in `checkpoint`, `repoOf` has nothing and the row cannot open its
     own model card. */
  const got = parseCatalog({
    Split: {
      recipe: "sd-cpp",
      labels: ["image"],
      checkpoints: { main: "org/repo:model.gguf", text_encoder: "org/enc:enc.gguf" },
    },
  });
  assert.equal(got[0]?.checkpoint, "org/repo:model.gguf");
  assert.deepEqual(got[0]?.checkpoints, {
    main: "org/repo:model.gguf", text_encoder: "org/enc:enc.gguf",
  });
});

test("a checkpoints object with no main is ignored rather than half-read", () => {
  // The daemon refuses one, so carrying it would be a row that cannot register.
  const got = parseCatalog({ Odd: { recipe: "sd-cpp", labels: ["image"], checkpoints: { vae: "org/repo:v.safetensors" } } });
  assert.equal(got[0]?.checkpoints, undefined);
  assert.equal(got[0]?.checkpoint, undefined);
});
