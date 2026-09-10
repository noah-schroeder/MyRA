/**
 * What Karen has learned about a model, beside what the daemon can tell it.
 *
 * Two facts, both small, both from files the model's own authors published:
 * its architecture, which is what lets `fit.ts` size a context window by
 * arithmetic rather than by a rule of thumb; and the sampler settings they
 * shipped in `generation_config.json`, which is where "temperature 0.6, top-p
 * 0.95" comes from for anyone who has read a model card.
 *
 * Three rules.
 *
 * **Learned when a model is downloaded, never when one is loaded.** Loading a
 * model must not become a network request -- main/review.ts documents at length
 * what happens when a question starts behaving like one, and a load that quietly
 * dials out on a machine that is offline or on a train is worse than a smaller
 * context window.
 *
 * **A failure is a fact and is stored too.** Gated repositories, GGUF repos with
 * no `config.json` and no `base_model`, models imported from LM Studio with no
 * repository at all, and being offline all produce the same answer, and an empty
 * record for them is what stops an offline machine re-asking on every download.
 *
 * **The file is Karen's, not the model directory's.** The models directory is a
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

export interface ModelFacts {
  /** The repository these came from, for the panel to attribute them to. */
  repo?: string;
  shape?: ModelShape;
  /** The authors' own sampler settings, applied under anything the user set. */
  suggested?: Sampling;
  /** The user has told this model's suggestions to stop applying. */
  ignoreSuggested?: boolean;
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
  const at = new Date().toISOString();
  const repo = checkpoint ? repoOf(checkpoint) : undefined;
  /* No repository to ask about: a model imported from LM Studio or Ollama is a
     path on this disk, and there is nothing to look up. Recorded, so this is
     not re-attempted on every download. */
  if (!repo) {
    all[model] = { at };
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

  const shape = shapeFromConfig(config);
  const suggested = samplingFromGenerationConfig(generation);
  const facts: ModelFacts = {
    at,
    repo: from,
    ...(shape ? { shape } : {}),
    ...(Object.keys(suggested).length ? { suggested } : {}),
    /* Kept across a re-learn: the user turned the suggestions off for this
       model, and fetching a newer config is not them changing their mind. */
    ...(all[model]?.ignoreSuggested ? { ignoreSuggested: true } : {}),
  };
  all[model] = facts;
  await writeAll(all);
  return facts;
}
