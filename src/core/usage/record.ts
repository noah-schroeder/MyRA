/**
 * One model call, as the usage dashboard remembers it.
 *
 * Counts, never content. A record says which model answered, where it ran, who
 * asked, how many tokens went each way and how long it took -- and nothing of
 * what was said. The gateway's request log (core/api/log.ts) holds the same
 * line for the same reason: a prompt log is the single most sensitive thing this
 * application could keep, and the strongest guarantee is a shape that has no
 * field to put one in.
 *
 * No imports, so the renderer can read the same feature names main writes.
 */

/** What MyRA was doing when it asked. `api` is a client of the gateway, not MyRA. */
export const USAGE_FEATURES = [
  "chat",
  "research",
  "document",
  "review",
  "paper",
  "meeting",
  "project-notes",
  "compaction",
  "dictation",
  "voice",
  "image",
  "api",
  "other",
] as const;
export type UsageFeature = (typeof USAGE_FEATURES)[number];

export const FEATURE_WORDS: Record<UsageFeature, string> = {
  chat: "Chat",
  research: "Deep research",
  document: "Document drafts",
  review: "Peer review",
  paper: "Paper drafter",
  meeting: "Meetings",
  "project-notes": "Project notes",
  compaction: "Compaction",
  dictation: "Dictation",
  voice: "Spoken replies",
  image: "Images",
  api: "API clients",
  other: "Other",
};

/**
 * What sort of model call it was.
 *
 * Only `text` and `embeddings` are counted in tokens; the other three are
 * counted in what they are actually made of -- seconds of audio heard,
 * characters spoken, pictures drawn -- because a token count is not what a
 * transcription model or a diffusion model consumes.
 */
export const USAGE_KINDS = ["text", "embeddings", "transcription", "speech", "image"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

export type UsageOutcome = "ok" | "error" | "cancelled";
export type UsageWhere = "local" | "external";
export type UsageSource = "app" | "api";

export interface UsageRecord {
  v: 1;
  /** When the call finished, ISO in UTC. Bucketed into the local day on read. */
  at: string;
  kind: UsageKind;
  /** MyRA itself, or a client of the API gateway. */
  source: UsageSource;
  feature: UsageFeature;
  /** The model name as it went on the wire. */
  model: string;
  /** Empty id for MyRA's own runtime. The name is as it read at the time. */
  provider: { id: string; name: string };
  /** The same rule the privacy report uses: loopback and labelled local, or external. */
  where: UsageWhere;
  /** The project the call ran in, if it knew -- the name as it was then. */
  project?: { id: string; name: string };
  /** What the call was part of, so a project can claim it after the fact. */
  item?: { kind: string; ref: string };
  /** A research run's stage. */
  stage?: string;
  /** Which gateway key, by label. Never the key itself. */
  key?: { id: string; label: string };
  /*
   * Each count is ABSENT when the server did not report it, and zero only when
   * it said zero. A server that sends no usage block is common -- a gateway
   * client that never asked for one, an older llama.cpp -- and adding it to
   * the totals as nothing would make a busy model look idle.
   */
  input?: number;
  output?: number;
  /** Input tokens the server answered from its cache. Part of `input`, not added to it. */
  cached?: number;
  /** Reasoning tokens a provider charged for, when it itemised them. Part of `output`. */
  reasoning?: number;
  /** Wall clock for the whole call. */
  ms: number;
  ttftMs?: number;
  /** Time spent generating, for an honest tokens-per-second. */
  genMs?: number;
  outcome: UsageOutcome;
  /**
   * What the provider said this model cost per million tokens, at the moment of
   * the call -- frozen here because the provider's own listing is a cache that is
   * refreshed, and a price that changed next month must not reprice this one.
   */
  price?: { input: number; output: number };
  /** Seconds of audio, characters spoken, or images drawn -- per `kind`. */
  units?: number;
  /**
   * How many requests this line stands for, when it is more than one: a burst
   * from an API client merged into one line a second (coalesce.ts). Every
   * figure above is then the sum over them.
   */
  count?: number;
}

const str = (v: unknown, max = 300): string => (typeof v === "string" ? v.slice(0, max) : "");
const count = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

function oneOf<T extends string>(v: unknown, list: readonly T[], fallback: T): T {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Two string fields of a nested object, or nothing when it is not one. */
function pair(v: unknown, a: string, b: string): Record<string, string> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  return { [a]: str(o[a]), [b]: str(o[b]) };
}

/**
 * Read one line back, forgivingly.
 *
 * A record that is not even an object, or has no time, is dropped; anything
 * else is coerced field by field, because a dashboard that throws on the
 * fifth of ten thousand lines shows nothing at all -- the stance
 * images/store.ts and papers/store.ts already take.
 */
export function parseUsageRecord(raw: unknown): UsageRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const at = str(r["at"], 40);
  if (!at || Number.isNaN(Date.parse(at))) return undefined;
  const ms = count(r["ms"]) ?? 0;

  const provider = pair(r["provider"], "id", "name") as { id: string; name: string } | undefined;
  const project = pair(r["project"], "id", "name") as { id: string; name: string } | undefined;
  const item = pair(r["item"], "kind", "ref") as { kind: string; ref: string } | undefined;
  const key = pair(r["key"], "id", "label") as { id: string; label: string } | undefined;
  const priceRaw = r["price"] as { input?: unknown; output?: unknown } | undefined;
  const priceIn = count(priceRaw?.input);
  const priceOut = count(priceRaw?.output);

  const out: UsageRecord = {
    v: 1,
    at,
    kind: oneOf(r["kind"], USAGE_KINDS, "text"),
    source: r["source"] === "api" ? "api" : "app",
    feature: oneOf(r["feature"], USAGE_FEATURES, "other"),
    model: str(r["model"]),
    provider: provider ?? { id: "", name: "" },
    where: r["where"] === "local" ? "local" : "external",
    ms,
    outcome: oneOf(r["outcome"], ["ok", "error", "cancelled"] as const, "ok"),
  };
  if (project?.id) out.project = project;
  if (item?.kind && item.ref) out.item = item;
  if (typeof r["stage"] === "string" && r["stage"]) out.stage = str(r["stage"], 40);
  if (key?.id) out.key = key;
  for (const field of ["input", "output", "cached", "reasoning", "ttftMs", "genMs", "units"] as const) {
    const n = count(r[field]);
    if (n !== undefined) out[field] = n;
  }
  if (priceIn !== undefined && priceOut !== undefined) out.price = { input: priceIn, output: priceOut };
  const n = count(r["count"]);
  if (n !== undefined && n > 1) out.count = Math.floor(n);
  return out;
}

/** True for the kinds measured in tokens. */
export function countsTokens(kind: UsageKind): boolean {
  return kind === "text" || kind === "embeddings";
}
