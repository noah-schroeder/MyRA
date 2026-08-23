/**
 * Embeddings, called directly rather than through pi.
 *
 * pi is a chat agent; it has no embeddings verb. But the endpoint pi is already
 * pointed at serves /v1/embeddings, so this reads the SAME provider block out
 * of models.json -- base URL and the name of the env var holding the key -- and
 * calls it. No second place to configure an endpoint, and no key on disk: the
 * file stores "$KAREN_LLM_KEY", and the value only ever exists in the process
 * environment the bridge injected.
 *
 * Why embeddings at all: ranking ~500 candidate abstracts against the scope by
 * cosine similarity takes about two minutes and costs nothing, and it is
 * deterministic. Sending all 500 to a model for judgement would be slower,
 * dearer, and would still need a cheap pre-sort to be affordable.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { FETCH_TIMEOUT_MS, readResearchConfig } from "./config.ts";

/** Requests are sized to keep one batch comfortably inside any server's limits. */
const BATCH = 64;
const MAX_ATTEMPTS = 3;

export function piModelsPath(): string {
  return (
    process.env["KAREN_PI_MODELS"] ??
    join(process.env["HOME"] ?? homedir(), ".pi", "agent", "models.json")
  );
}

export interface Endpoint {
  baseUrl: string;
  apiKey: string;
}

interface ModelsFile {
  providers?: Record<string, { baseUrl?: string; apiKey?: string }>;
}

/**
 * Resolve the endpoint from the pi config the app already maintains.
 *
 * `apiKey` in that file is an env reference like "$KAREN_LLM_KEY" -- never a
 * literal. Anything else is treated as absent rather than used, because a
 * literal key in that file would mean the app's secret handling had broken.
 */
/**
 * The embeddings endpoint the user configured in Settings, if any.
 *
 * Preferred over the chat provider because they are usually not the same
 * server: llama.cpp serves one model per process, so the embedding model
 * typically listens on its own port with its own key.
 */
export function configuredEmbeddingEndpoint(): (Endpoint & { model: string }) | undefined {
  const cfg = readResearchConfig().embeddings;
  if (!cfg?.baseUrl || !cfg.model) return undefined;
  const apiKey = cfg.envVar ? (process.env[cfg.envVar] ?? "") : "";
  if (cfg.envVar && !apiKey) {
    throw new Error(
      `${cfg.envVar} is not set in this process — the embeddings key has not reached the VM. ` +
        `Re-enter it in Settings.`,
    );
  }
  return { baseUrl: cfg.baseUrl.replace(/\/$/, ""), apiKey, model: cfg.model };
}

/**
 * Fall back to the chat provider's endpoint.
 *
 * Only correct when one server happens to serve both, so it is the fallback
 * rather than the default.
 */
export function resolveEndpoint(provider?: string, path = piModelsPath()): Endpoint {
  let file: ModelsFile;
  try {
    file = JSON.parse(readFileSync(path, "utf8")) as ModelsFile;
  } catch {
    throw new Error(`no model configuration at ${path} — configure an endpoint in Settings first`);
  }
  const providers = Object.entries(file.providers ?? {});
  if (providers.length === 0) throw new Error("no providers configured — open Settings");

  const chosen = provider
    ? providers.find(([name]) => name === provider)
    : providers[0];
  if (!chosen) throw new Error(`provider "${provider}" is not configured`);

  const [name, spec] = chosen;
  if (!spec.baseUrl) throw new Error(`provider "${name}" has no baseUrl`);

  const ref = spec.apiKey ?? "";
  const envName = ref.startsWith("$") ? ref.slice(1) : "";
  const apiKey = envName ? (process.env[envName] ?? "") : "";
  if (envName && !apiKey) {
    throw new Error(
      `${envName} is not set in this process — the endpoint key has not reached the VM. ` +
        `Re-enter it in Settings.`,
    );
  }
  return { baseUrl: spec.baseUrl.replace(/\/$/, ""), apiKey };
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
