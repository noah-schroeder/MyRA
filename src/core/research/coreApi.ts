/**
 * CORE (core.ac.uk): open-access full text aggregated from institutional
 * repositories worldwide -- the other half of what OpenAlex mostly only knows
 * the existence of.
 *
 * Named `coreApi.ts`, not `core.ts`: a module called `core.ts` inside
 * `src/core/research/` would read, to the next person searching this tree, as
 * though it meant `src/core` itself.
 *
 * Unlike OpenAlex and arXiv, CORE requires a key on every request -- there is
 * no keyless tier -- so this provider is offered in the app only once a key
 * exists (see databases.ts), and every call here assumes one is present.
 */

import { FETCH_TIMEOUT_MS } from "./config.ts";
import { databaseKey } from "./keys.ts";

const BASE = "https://api.core.ac.uk/v3";

export interface CoreRecord {
  id: string;
  title: string;
  authors: string[];
  abstract: string;
  year?: number;
  doi?: string;
  /** A readable full-text copy, when CORE has one. */
  downloadUrl?: string;
  publisher?: string;
}

/*
 * CORE's free tier is the tightest of the four providers -- published figures
 * put it around 10 requests/minute. One request every 6 seconds stays under
 * that without depending on the exact published number, which CORE has
 * changed before.
 */
let nextAllowedAt = 0;
async function throttle(): Promise<void> {
  const wait = nextAllowedAt - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  nextAllowedAt = Date.now() + 6_000;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Parse CORE's `/search/works` response. Split out so it can be tested
 * against a fixture with no network.
 *
 * A work record can carry a `fullText` field holding the entire paper's text
 * -- discarded here, at the parse boundary, regardless of size: this provider
 * yields a SearchHit like every other, and the full text is read later, if at
 * all, the same way any other provider's full text is: by fetching the
 * `downloadUrl` in the retrieve stage.
 */
export function parseCoreResults(json: unknown): CoreRecord[] {
  const body = json as { results?: unknown[] } | undefined;
  const results = Array.isArray(body?.results) ? body!.results : [];
  const out: CoreRecord[] = [];
  for (const raw of results) {
    const r = raw as Record<string, unknown>;
    const title = str(r["title"]).trim();
    const id = str(r["id"]).trim();
    const doi = typeof r["doi"] === "string" ? (r["doi"] as string).trim() : "";
    const downloadUrl = typeof r["downloadUrl"] === "string" ? (r["downloadUrl"] as string).trim() : "";
    // A record with no title and no identifying URL cannot become a usable
    // hit -- nothing downstream could show, cite or dedupe it by.
    if (!title || (!id && !doi && !downloadUrl)) continue;

    const authors = Array.isArray(r["authors"])
      ? (r["authors"] as unknown[])
          .map((a) => (typeof a === "object" && a ? str((a as Record<string, unknown>)["name"]) : str(a)))
          .filter(Boolean)
      : [];

    const year = num(r["yearPublished"]);
    const publisher = str(r["publisher"]).trim();
    out.push({
      id,
      title,
      authors,
      abstract: str(r["abstract"]).trim(),
      ...(year !== undefined ? { year } : {}),
      ...(doi ? { doi } : {}),
      ...(downloadUrl ? { downloadUrl } : {}),
      ...(publisher ? { publisher } : {}),
    });
  }
  return out;
}

/** `page` is 1-based, matching the other providers. */
export async function coreSearch(
  query: string,
  perPage: number,
  signal?: AbortSignal,
  page = 1,
): Promise<CoreRecord[]> {
  const key = await databaseKey("coreKey");
  if (!key) throw new Error("CORE needs an API key. Add one in Settings → Database keys.");

  await throttle();
  const q = new URLSearchParams({
    q: query,
    limit: String(perPage),
    offset: String(Math.max(0, page - 1) * perPage),
  });
  const res = await fetch(`${BASE}/search/works?${q}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 429) {
    throw new Error("CORE's rate limit was hit. Wait a moment before searching again.");
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error("CORE rejected the stored API key. Check it in Settings → Database keys.");
  }
  if (!res.ok) throw new Error(`CORE returned ${res.status} ${res.statusText}`);
  return parseCoreResults(await res.json());
}
