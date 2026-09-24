/**
 * Models MyRA offers that Lemonade's own catalogue does not carry yet.
 *
 * A deliberately short list, and it is meant to stay short. Lemonade ships a
 * curated catalogue and that is the right place for this: `LEMONADE_VERSION` is
 * pinned and upgraded on purpose, so a model published between MyRA releases
 * would otherwise be unreachable without somebody typing three addresses into
 * the manual form.
 *
 * Two rules keep it from becoming a second catalogue nobody maintains.
 *
 * **Upstream always wins.** `mergeCatalog` drops anything whose id the daemon
 * already knows, so a model added here disappears the moment Lemonade ships it
 * -- which is what stops a bumped LEMONADE_VERSION from producing two rows for
 * one model, the newer of them shadowed by a copy frozen here.
 *
 * **Every entry carries its own `checkpoints`.** A row the daemon has never
 * heard of cannot be pulled by name, so the definition has to travel with it
 * and be registered before the transfer starts -- the same
 * `myra:register-image-model` call the manual form makes.
 */

import type { CatalogEntry } from "./catalog.ts";

/** Gigabytes to the bytes a `CatalogEntry` carries. */
function gb(n: number): number {
  return Math.round(n * 1024 ** 3);
}

export const MYRA_CATALOG: CatalogEntry[] = [
  {
    /*
     * Qwen-Image 2.1, as GGUF rather than as its publisher ships it.
     *
     * `Comfy-Org/Qwen-Image-2.1` is the upstream repository and the wrong
     * source here: beyond the VAE, its files are either bf16 -- 13.2 GB of
     * diffusion model and 16.3 GB of text encoder, 30 GB before the VAE, which
     * does not fit the machines this is for -- or `int8_convrot`/`w4a8`, which
     * are ComfyUI's own quantisation formats and not something sd.cpp reads.
     * So the diffusion model and the encoder come from the GGUF republications
     * and only the VAE comes from the original, which is the one file there
     * that is neither too big nor in a format nothing here can open.
     *
     * Q8_0 on both: 15.9 GB all in, against Lemonade's own Qwen-Image-2512 at
     * 19.4 GB, so anything that can hold the catalogue's Qwen-Image can hold
     * this one.
     *
     * The architecture is supported by the pinned sd-cpp build rather than
     * assumed to be: `libstable-diffusion.so` in `master-827-97d2990` carries
     * `Qwen3VLDeepStackMerger` and `model.visual.deepstack_merger_list.`,
     * which is the encoder machinery 2.1 needs and which the earlier
     * Qwen2.5-VL models do not use.
     */
    id: "Qwen-Image-2.1",
    recipe: "sd-cpp",
    labels: ["image"],
    suggested: true,
    source: "huggingface",
    sizeBytes: gb(15.86),
    checkpoint: "unsloth/Qwen-Image-2.1-GGUF:qwen-image-2.1-Q8_0.gguf",
    checkpoints: {
      main: "unsloth/Qwen-Image-2.1-GGUF:qwen-image-2.1-Q8_0.gguf",
      text_encoder: "Qwen/Qwen3-VL-8B-Instruct-GGUF:Qwen3VL-8B-Instruct-Q8_0.gguf",
      vae: "Comfy-Org/Qwen-Image-2.1:vae/qwen_image_2.1_vae_bf16.safetensors",
    },
  },
];

/**
 * The daemon's catalogue, plus MyRA's additions that it does not already hold.
 *
 * Compared by id, which is the name a pull uses and therefore the thing two
 * rows would collide on.
 */
export function mergeCatalog(
  upstream: CatalogEntry[],
  extra: CatalogEntry[] = MYRA_CATALOG,
): CatalogEntry[] {
  const known = new Set(upstream.map((e) => e.id));
  return [...upstream, ...extra.filter((e) => !known.has(e.id))];
}
