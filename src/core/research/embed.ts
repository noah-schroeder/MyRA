/**
 * Embeddings: ranking candidate abstracts against the scope, cheaply.
 *
 * Ranking ~500 abstracts by cosine similarity takes about two minutes, costs
 * nothing, and is deterministic. Sending all 500 to a model for judgement
 * would be slower, dearer, and would still need a cheap pre-sort to be
 * affordable at all.
 *
 * The endpoint comes from Settings, like every other endpoint in the app. It
 * used to be read out of `~/.pi/agent/models.json`, which pi maintained; when
 * pi was removed that file stopped existing and nothing noticed, because the
 * failure was silent in the worst way -- no embeddings model meant the ranking
 * stage was skipped and the shortlist became "the first N in search order".
 */

import { ConfigStore, type Settings } from "../config.ts";
import { FETCH_TIMEOUT_MS } from "./config.ts";

/** Requests are sized to keep one batch comfortably inside any server's limits. */
const BATCH = 64;
const MAX_ATTEMPTS = 3;

export interface Endpoint {
  baseUrl: string;
  apiKey: string;
}

/**
 * The embeddings endpoint the user configured, if any.
 *
 * Returns undefined rather than throwing when none is set: no embeddings model
 * is a legitimate configuration, and the pipeline has a documented fallback for
 * it. A configured endpoint whose KEY has not arrived is a different thing --
 * that is a broken setup, and it says so.
 */
export function configuredEmbeddingEndpoint(
  settings: Pick<Settings, "embeddings">,
): (Endpoint & { model: string }) | undefined {
  const cfg = settings.embeddings;
  if (!cfg?.baseUrl || !cfg.model) return undefined;
  const apiKey = cfg.envVar ? (process.env[cfg.envVar] ?? "") : "";
  if (cfg.envVar && !apiKey) {
    throw new Error(
      `${cfg.envVar} is not set in this process — the embeddings key has not been ` +
        `unlocked. Re-enter it in Settings → Providers.`,
    );
  }
  return { baseUrl: cfg.baseUrl.replace(/\/$/, ""), apiKey, model: cfg.model };
}

/** Loads settings from disk to answer the same question. Used by the pipeline. */
export async function embeddingEndpoint(): Promise<(Endpoint & { model: string }) | undefined> {
  const store = new ConfigStore();
  return configuredEmbeddingEndpoint(await store.load());
}

interface EmbeddingResponse {
  data?: { index?: number; embedding?: number[] }[];
  error?: { message?: string };
}

async function embedBatch(
  texts: string[],
  model: string,
  endpoint: Endpoint,
  signal?: AbortSignal,
): Promise<number[][]> {
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${endpoint.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
        },
        body: JSON.stringify({ model, input: texts }),
        signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS * 3),
      });
    } catch (err) {
      lastError = (err as Error).message;
      if (signal?.aborted) throw new Error("embedding aborted");
      continue;
    }

    // Overload and transient server errors are worth another try; a 400 saying
    // the model does not exist is not, and retrying it just wastes two minutes.
    if (res.status === 429 || res.status >= 500) {
      lastError = `${res.status} ${res.statusText}`;
      await new Promise((r) => setTimeout(r, 500 * attempt * attempt));
      continue;
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as EmbeddingResponse;
      throw new Error(
        `embeddings request failed (${res.status}): ${body.error?.message ?? res.statusText}`,
      );
    }

    const body = (await res.json()) as EmbeddingResponse;
    const rows = body.data ?? [];
    if (rows.length !== texts.length) {
      throw new Error(`embeddings returned ${rows.length} vectors for ${texts.length} inputs`);
    }
    // The response carries an index per row; trusting array order instead would
    // silently pair each abstract with someone else's vector.
    const out = new Array<number[]>(texts.length);
    for (const [i, row] of rows.entries()) {
      const at = row.index ?? i;
      if (!row.embedding?.length) throw new Error(`embedding ${at} came back empty`);
      out[at] = row.embedding;
    }
    return out;
  }
  throw new Error(`embeddings endpoint unreachable after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}

/** Embed many texts, batched. Order of the result matches order of the input. */
export async function embedTexts(
  texts: string[],
  model: string,
  endpoint: Endpoint,
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    out.push(...(await embedBatch(batch, model, endpoint, signal)));
    onProgress?.(Math.min(i + BATCH, texts.length), texts.length);
  }
  return out;
}

/** Cosine similarity. Returns 0 for a zero vector rather than NaN. */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Rank items against a query vector, best first. Ties keep input order. */
export function rankBySimilarity<T>(
  items: T[],
  vectors: number[][],
  query: number[],
): { item: T; score: number; index: number }[] {
  return items
    .map((item, index) => ({ item, index, score: cosine(vectors[index] ?? [], query) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
}
