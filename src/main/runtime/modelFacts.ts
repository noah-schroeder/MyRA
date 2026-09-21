/**
 * What MyRA has learned about a model, beside what the daemon can tell it.
 *
 * Two facts, both small: its architecture, which is what lets `fit.ts` size a
 * context window by arithmetic rather than by a rule of thumb; and the sampler
 * settings shipped in `generation_config.json`, which is where "temperature
 * 0.6, top-p 0.95" comes from for anyone who has read a model card.
 *
 * The shape has two possible sources, and `shapeFrom` says which answered.
 * `learnFacts` below reads `config.json` over the network, the way this always
 * worked; `learnShapeFromFile` reads the model's own GGUF header off disk, which
 * is preferred wherever both could answer -- the header describes the quantised
 * file that will actually load rather than an unquantised parent, and it is the
 * only source that can see a hybrid architecture's per-layer KV cache at all. A
 * `config.json` guess is never allowed to overwrite a GGUF measurement.
 *
 * Rules.
 *
 * **A network fetch is learned only when a model is downloaded, never when one
 * is loaded.** Loading a model must not become a network request --
 * main/review.ts documents at length what happens when a question starts
 * behaving like one, and a fetch that quietly dials out on a machine that is
 * offline or on a train is worse than a smaller context window. Reading the
 * GGUF header is not this rule's concern: it is a local read of a file the
 * loader is about to mmap in full, not a request, and `manager.ts` calls it
 * lazily at load for exactly the models a download-time fetch never reached.
 *
 * **A network failure is a fact and is stored too.** Gated repositories, GGUF
 * repos with no `config.json` and no `base_model`, models imported from LM
 * Studio with no repository at all, and being offline all produce the same
 * answer, and an empty record for them is what stops an offline machine
 * re-asking on every download. **A local GGUF read failure is the opposite: it
 * is never stored.** It fails for reasons that heal on their own -- the index
 * not yet rebuilt, the daemon mid-start -- and persisting "no shape" for one
 * would be exactly the bug this file exists to prevent.
 *
 * **The file is MyRA's, not the model directory's.** The models directory is a
 * setting people move, and Lemonade scans it and names a model after the leaf
 * directory it finds -- a stray JSON in there is at best ignored and at worst a
 * model that does not exist.
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_DIR, makeOwnDir, OWNER_ONLY_FILE } from "../../core/paths.ts";
import { samplingFromGenerationConfig, type Sampling } from "../../core/llm/sampling.ts";
import { shapeFromConfig } from "../../core/runtime/modelShape.ts";
import { repoOf } from "../../core/runtime/catalog.ts";
import type { ModelShape } from "../../core/runtime/fit.ts";
import { repoConfig, repoDetail, repoGenerationConfig } from "./hfClient.ts";
import { readShapeFromFile } from "./ggufFile.ts";

export interface ModelFacts {
  /** The repository these came from, for the panel to attribute them to. */
  repo?: string;
  shape?: ModelShape;
  /**
   * Which source answered: the model's own GGUF header, or a `config.json`
   * guess. A record written before this field existed has neither -- treated
   * the same as `"config"`, since a GGUF read is always worth trying over it.
   */
  shapeFrom?: "gguf" | "config";
  /** The authors' own sampler settings, applied under anything the user set. */
  suggested?: Sampling;
  /** The user has told this model's suggestions to stop applying. */
  ignoreSuggested?: boolean;
  /**
   * The `ctx_size` MyRA itself computed and wrote, when it did.
   *
   * The daemon's `saved` map cannot tell MyRA's own patch apart from a value
   * the user typed -- both arrive through the same `POST /models/{id}/options`
   * -- so this is the only record of which one a saved number is. Absent means
   * either nothing has been written, or the user's own edit was seen and this
   * was cleared: see `ctxIsOurs` in `core/runtime/modelOptions.ts`.
   */
  autoCtxSize?: number;
  /**
   * Deliberately trade GPU residency for a longer context window, for this
   * model. Off unless the user turns it on in the tuning panel -- MyRA's own
   * auto-tune never opts into a window it knows will spill the model off the
   * card. See `autoContext`'s own doc comment in `core/runtime/fit.ts`.
   */
  allowOffload?: boolean;
  /** ISO. Distinguishes "asked and found nothing" from "never asked". */
  at: string;
}

function factsPath(): string {
  return join(CONFIG_DIR, "modelFacts.json");
}

async function readAll(): Promise<Record<string, ModelFacts>> {
  try {
    const raw = JSON.parse(await readFile(factsPath(), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw as Record<string, ModelFacts>;
  } catch {
    /* Missing, or edited into nonsense. Both mean "nothing is known yet",
       which is a state this already handles on every fresh install. */
    return {};
  }
}

async function writeAll(all: Record<string, ModelFacts>): Promise<void> {
  await makeOwnDir(CONFIG_DIR);
  const target = factsPath();
  const temp = `${target}.partial`;
  await writeFile(temp, JSON.stringify(all, null, 2), { mode: OWNER_ONLY_FILE });
  await rename(temp, target);
}

export async function factsFor(model: string): Promise<ModelFacts | undefined> {
  return (await readAll())[model];
}

/** The sampler settings to start from, unless the user has switched them off. */
export async function suggestedFor(model: string): Promise<Sampling> {
  const facts = await factsFor(model);
  return facts && !facts.ignoreSuggested ? (facts.suggested ?? {}) : {};
}

/**
 * Record, or clear, the `ctx_size` MyRA itself last wrote for a model.
 *
 * Called from two places, for two directions of the same rule. `manager.ts`'s
 * `#autoTuneLoad` writes it the moment its own patch is accepted by the
 * daemon, so the next load can recognise the saved value as its own; and it
 * clears it the moment it finds a saved value that does NOT match -- the
 * user's own edit, arrived at through the very same daemon endpoint MyRA's
 * patch uses. Clearing here, on the read path rather than only when writing,
 * is what stops MyRA going on claiming a value the instant somebody changes
 * it by hand: the very next load already finds nothing recorded and leaves it
 * alone, rather than fighting the user for another cycle.
 *
 * `tokens: undefined` clears with no existing record is a deliberate no-op --
 * there is nothing to clear, and writing an empty record for a model MyRA has
 * never otherwise heard of would be a fact this file has no business
 * inventing.
 */
export async function setAutoCtxSize(model: string, tokens: number | undefined): Promise<void> {
  const all = await readAll();
  const existing = all[model];
  if (tokens === undefined) {
    if (existing?.autoCtxSize === undefined) return;
    const { autoCtxSize: _drop, ...rest } = existing;
    all[model] = rest;
  } else {
    all[model] = { ...(existing ?? { at: new Date().toISOString() }), autoCtxSize: tokens };
  }
  await writeAll(all);
}

/** Turn spilling a model off the card, for a longer context, on or off. */
export async function setAllowOffload(model: string, allow: boolean): Promise<void> {
  const all = await readAll();
  all[model] = { ...(all[model] ?? { at: new Date().toISOString() }), allowOffload: allow };
  await writeAll(all);
}

export async function setIgnoreSuggested(model: string, ignore: boolean): Promise<void> {
  const all = await readAll();
  const existing = all[model];
  if (!existing) return;
  all[model] = { ...existing, ignoreSuggested: ignore };
  await writeAll(all);
}

/**
 * Ask Hugging Face what this model is, once, and remember the answer.
 *
 * The config lives on the repository the weights were trained in, and a
 * quantised GGUF repository is not that one -- it holds a `.gguf` and a README.
 * So a missing `config.json` is followed to `base_model`, which is the field
 * `parseRepoDetail` already reads for the licence.
 *
 * Nothing is sent but the repository name, and no token is ever attached.
 */
export async function learnFacts(model: string, checkpoint?: string): Promise<ModelFacts> {
  const all = await readAll();
  const existing = all[model];
  /* A shape already measured from the model's own GGUF header describes the
     quantised file that will actually load; a config.json guess must never
     overwrite it -- the header is right about a hybrid's per-layer KV cache in
     a way a flat headCountKv from config.json cannot be. Carried through both
     branches below rather than only the one with a repository, since a record
     can in principle hold a GGUF shape with no known repository at all. */
  const priorGgufShape = existing?.shapeFrom === "gguf" ? existing.shape : undefined;
  const carried = {
    ...(priorGgufShape ? { shape: priorGgufShape, shapeFrom: "gguf" as const } : {}),
    /* Kept across a re-learn: the user turned the suggestions off for this
       model, and fetching a newer config is not them changing their mind. */
    ...(existing?.ignoreSuggested ? { ignoreSuggested: true } : {}),
    /* Kept for the same reason: a re-learn of the repository facts is not the
       user editing ctx_size, and must not make MyRA forget it wrote it. */
    ...(existing?.autoCtxSize !== undefined ? { autoCtxSize: existing.autoCtxSize } : {}),
    ...(existing?.allowOffload ? { allowOffload: true } : {}),
  };
  const at = new Date().toISOString();
  const repo = checkpoint ? repoOf(checkpoint) : undefined;
  /* No repository to ask about: a model imported from LM Studio or Ollama is a
     path on this disk, and there is nothing to look up. Recorded, so this is
     not re-attempted on every download. */
  if (!repo) {
    all[model] = { at, ...carried };
    await writeAll(all);
    return all[model];
  }

  let config = await repoConfig(repo);
  let generation = await repoGenerationConfig(repo);
  let from = repo;

  if (!config || !generation) {
    const base = await repoDetail(repo)
      .then((d) => (Array.isArray(d.baseModel) ? d.baseModel[0] : d.baseModel))
      .catch(() => undefined);
    if (base && base !== repo) {
      config = config ?? (await repoConfig(base));
      generation = generation ?? (await repoGenerationConfig(base));
      if (config || generation) from = base;
    }
  }

  const configShape = shapeFromConfig(config);
  const suggested = samplingFromGenerationConfig(generation);
  const facts: ModelFacts = {
    at,
    repo: from,
    ...carried,
    ...(!priorGgufShape && configShape ? { shape: configShape, shapeFrom: "config" as const } : {}),
    ...(Object.keys(suggested).length ? { suggested } : {}),
  };
  all[model] = facts;
  await writeAll(all);
  return facts;
}

/**
 * Learn a model's shape from its own GGUF header, when the file is on disk.
 *
 * Preferred over the `config.json` path above wherever both could answer --
 * see this file's header comment for why -- and reached from two places:
 * `manager.ts`'s public `learnShape`, which `main/runtime/ipc.ts`'s
 * download-finished handler awaits immediately before `learnFacts`, and
 * `manager.ts`'s own `#autoTuneLoad` lazily at first load, which is what
 * reaches every route that never triggers a download-time fetch at all: LM
 * Studio and Ollama imports, and anything installed before this existed.
 *
 * Never overwrites a shape this same function already recorded. A read that
 * fails or finds nothing writes nothing -- see the header comment on why a
 * local read's failure is never persisted, unlike a network fetch's.
 */
export async function learnShapeFromFile(model: string, path: string): Promise<ModelFacts | undefined> {
  const all = await readAll();
  const existing = all[model];
  if (existing?.shapeFrom === "gguf") return existing;
  const shape = await readShapeFromFile(path).catch(() => undefined);
  if (!shape) return existing;
  const facts: ModelFacts = { ...existing, at: existing?.at ?? new Date().toISOString(), shape, shapeFrom: "gguf" };
  all[model] = facts;
  await writeAll(all);
  return facts;
}
