/**
 * The three things the Models page has to get right about a file it offers.
 *
 * Which quantisation a filename names, whether the machine can hold it, and
 * whether it is already downloaded. Each of the three was wrong in a way a
 * person could see:
 *
 *   - eleven filenames with no explanation, offered to researchers who have no
 *     reason to have learnt what `Q4_K_M` means;
 *   - a "Recommended" badge fixed to `Q4_K_M` whether or not the card could
 *     hold it, which is the app recommending the choice that will not work;
 *   - a "Downloaded" test against `modelNameFor` while downloads register
 *     under `pullName`, so the button on a model already on disk said
 *     Download.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { quantRank } from "../src/core/runtime/fit.ts";
import { listedId, pulledId, pullName } from "../src/core/runtime/hfBrowse.ts";
import { isDynamic, quantOf } from "../src/core/runtime/quants.ts";
import { recommendVariant, type RepoVariant } from "../src/core/runtime/registry.ts";

const variant = (name: string, gb: number): RepoVariant => ({
  name,
  primaryFile: `model-${name}.gguf`,
  files: [`model-${name}.gguf`],
  sharded: false,
  sizeBytes: Math.round(gb * 1024 ** 3),
});

describe("reading a quantisation name", () => {
  it("finds it mid-filename and on its own", () => {
    assert.equal(quantOf("Qwen3-8B-Q4_K_M.gguf")?.id, "Q4_K_M");
    assert.equal(quantOf("Q4_K_M")?.id, "Q4_K_M");
  });

  it("does not read IQ4_XS as Q4", () => {
    /* The reason the lookup is anchored on a word boundary rather than being a
       substring search: every `IQ*` name contains a `Q*` name. */
    assert.equal(quantOf("model-IQ4_XS.gguf")?.id, "IQ4_XS");
    assert.equal(quantOf("model-IQ3_XXS.gguf")?.id, "IQ3_XXS");
  });

  it("does not read BF16 as F16", () => {
    assert.equal(quantOf("model-BF16.gguf")?.id, "BF16");
  });

  it("prefers the longer name where one contains another", () => {
    assert.equal(quantOf("model-Q4_K_S.gguf")?.id, "Q4_K_S");
    assert.equal(quantOf("model-Q3_K_L.gguf")?.id, "Q3_K_L");
  });

  it("says nothing rather than guessing", () => {
    assert.equal(quantOf("sd_turbo.safetensors"), undefined);
  });

  it("tells the mixed-precision builds apart from the plain ones", () => {
    /* `Q2_K`, `Q2_K_L` and `Q2_K_XL` are three different files at three
       different sizes, and reading all three as `Q2_K` put three identical rows
       on the card. */
    assert.equal(quantOf("Q2_K")?.id, "Q2_K");
    assert.equal(quantOf("Q2_K_L")?.id, "Q2_K_L");
    assert.equal(quantOf("Q6_K_L")?.id, "Q6_K_L");
    assert.equal(quantOf("UD-Q4_K_XL")?.id, "Q4_K_XL");
  });

  it("marks a dynamic build, which is a different file and not a label", () => {
    assert.equal(isDynamic("UD-Q4_K_XL"), true);
    assert.equal(isDynamic("Q4_K_XL"), false);
  });

  it("gives every family a sentence somebody could act on", () => {
    for (const name of ["Q2_K", "Q4_K_M", "Q8_0", "F16", "IQ4_XS"]) {
      const quant = quantOf(name);
      assert.ok(quant, `${name} has no note`);
      assert.ok(quant.note.length > 30 && quant.note.endsWith("."), `${name}: ${quant.note}`);
    }
  });
});

describe("which version to recommend", () => {
  const all = [variant("Q2_K", 3), variant("Q4_K_M", 5), variant("Q6_K", 7), variant("Q8_0", 9)];

  /** On the card, then anywhere at all, then not at all. */
  const onCard = (limit: number) => (b: number): number =>
    b <= limit * 1024 ** 3 ? 0 : b <= 12 * 1024 ** 3 ? 1 : Infinity;

  it("is Q4_K_M when it fits, not the biggest thing that does", () => {
    // Bigger is not better here: a card with room to spare still gets Q4_K_M.
    assert.equal(recommendVariant(all, quantRank, onCard(10))?.name, "Q4_K_M");
  });

  it("steps down to the best build the card can actually hold", () => {
    assert.equal(recommendVariant(all, quantRank, onCard(4))?.name, "Q2_K");
  });

  it("prefers something that runs at all over something that does not", () => {
    /* The badge that started this: on a machine with no accelerator nothing is
       in the top tier, and "Recommended" sat next to "Too large". */
    const tier = (b: number): number => (b <= 6 * 1024 ** 3 ? 1 : Infinity);
    assert.equal(recommendVariant(all, quantRank, tier)?.name, "Q4_K_M");
    const tighter = (b: number): number => (b <= 4 * 1024 ** 3 ? 1 : Infinity);
    assert.equal(recommendVariant(all, quantRank, tighter)?.name, "Q2_K");
  });

  it("still names one when nothing runs", () => {
    /* "Nothing here will run well, and this is the one to try" is more useful
       than an empty column. */
    assert.equal(recommendVariant(all, quantRank, () => Infinity)?.name, "Q4_K_M");
  });

  it("keeps the old answer when the machine is unknown", () => {
    assert.equal(recommendVariant(all, quantRank)?.name, "Q4_K_M");
  });

  it("ignores a variant whose size the registry did not report", () => {
    const unsized: RepoVariant = { name: "Q4_K_M", primaryFile: "a.gguf", files: [], sharded: false };
    assert.equal(recommendVariant([unsized, variant("Q6_K", 2)], quantRank, () => 0)?.name, "Q6_K");
  });
});

describe("the id a download will be listed under", () => {
  it("is the pull name without the namespace the daemon strips", () => {
    /* Measured: registering `user.myra-delete-probe` answers with
       `id: "myra-delete-probe"`, and `embeddinggemma-300M-GGUF-Q8_0` sits in
       `/models` under exactly that shape. */
    assert.equal(pullName("ggml-org/embeddinggemma-300M-GGUF", "Q8_0"), "user.embeddinggemma-300M-GGUF-Q8_0");
    assert.equal(pulledId("ggml-org/embeddinggemma-300M-GGUF", "Q8_0"), "embeddinggemma-300M-GGUF-Q8_0");
  });

  it("is what main looks the finished download up by", () => {
    /* Both lookups after a pull used the `user.` name and so found nothing:
       the wait for the model to appear ran its retries out every time, and the
       shape learned from the registry was filed under a key nothing reads. */
    assert.equal(listedId("user.embeddinggemma-300M-GGUF-Q8_0"), "embeddinggemma-300M-GGUF-Q8_0");
    // A name that never had the namespace is already the listed id.
    assert.equal(listedId("SmolLM2-135M-Instruct-GGUF"), "SmolLM2-135M-Instruct-GGUF");
  });

  it("flattens the same way the name does, so the two cannot disagree", () => {
    const repo = "someone/Odd Name!!";
    assert.equal(pulledId(repo, "Q4_K_M"), pullName(repo, "Q4_K_M").replace(/^user\./, ""));
    assert.equal(pulledId(repo, "Q4_K_M").includes(" "), false);
  });
});
