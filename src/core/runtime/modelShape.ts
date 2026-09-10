/**
 * A model's architecture, read from the file its authors published.
 *
 * `fit.ts` has always known how to compute a KV cache exactly -- layers, KV
 * heads, head dimension, context, element size -- and has never had those
 * numbers to work with. Lemonade's catalogue gives a download size and nothing
 * about the shape, so every estimate took the rule-of-thumb path: a cache
 * proportional to the file, which is the same figure at 4k and at 128k and
 * therefore cannot answer "how long a window fits". This is where the real
 * numbers come from.
 *
 * They come from Hugging Face's `config.json`, which is a small text file next
 * to the weights. A quantised GGUF repository usually has none -- it holds one
 * `.gguf` and a README -- so the fetch follows `base_model` to the repository it
 * was quantised from, which does.
 *
 * **A partial shape is not a shape.** Every field below is needed to compute a
 * cache, and a half-read config would produce a number that looks measured and
 * is not. `kvCacheBytes` already refuses one; this refuses to build one.
 *
 * Pure: no fetch, no disk. What does the fetching is main/runtime/modelFacts.ts.
 */

import type { ModelShape } from "./fit.ts";

function count(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/**
 * `config.json` as a shape, or nothing.
 *
 * The names are the transformers ones, which every published config uses
 * whatever the architecture. `head_dim` is preferred where it exists because a
 * few families set it independently of `hidden_size / num_attention_heads` --
 * and where they do, the derived figure is wrong rather than approximate.
 */
export function shapeFromConfig(raw: unknown): ModelShape | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;

  const layers = count(row, "num_hidden_layers");
  const headCount = count(row, "num_attention_heads");
  const embeddingLength = count(row, "hidden_size");
  /* Absent on a model with no grouped-query attention, where every attention
     head keeps its own cache -- so the fallback is the attention head count
     rather than a refusal. */
  const headCountKv = count(row, "num_key_value_heads") ?? headCount;
  const keyLength =
    count(row, "head_dim") ??
    (embeddingLength && headCount && embeddingLength % headCount === 0
      ? embeddingLength / headCount
      : undefined);

  if (!layers || !headCount || !headCountKv || !keyLength) return undefined;

  const architecture = Array.isArray(row["architectures"])
    ? row["architectures"].find((a): a is string => typeof a === "string")
    : typeof row["model_type"] === "string"
      ? (row["model_type"] as string)
      : undefined;
  const contextLength = count(row, "max_position_embeddings");
  const experts = expertCount(row);

  return {
    layers,
    headCount,
    headCountKv,
    keyLength,
    valueLength: count(row, "v_head_dim") ?? keyLength,
    ...(embeddingLength ? { embeddingLength } : {}),
    ...(contextLength ? { contextLength } : {}),
    ...(architecture ? { architecture } : {}),
    ...(experts ? { experts } : {}),
  };
}

/**
 * Whether this is a mixture-of-experts model, and how many experts it routes
 * between -- the field that decides whether `--n-cpu-moe` is offered at all.
 *
 * No single name is universal: `num_local_experts` (Mixtral, GPT-OSS),
 * `num_experts` (Qwen's MoE family), `n_routed_experts` (DeepSeek). A dense
 * model's `model_type`/`architectures` does not reliably say "moe" either --
 * Mixtral and DBRX do not spell it -- so this checks the numeric fields
 * directly rather than pattern-matching a name.
 */
function expertCount(row: Record<string, unknown>): number | undefined {
  return count(row, "num_local_experts") ?? count(row, "num_experts") ?? count(row, "n_routed_experts");
}
