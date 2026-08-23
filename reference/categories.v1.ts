/**
 * Which SearXNG categories are scholarly — asked of SearXNG, not assumed.
 *
 * This gates the OpenAlex hydration step. Hydration is only meaningful for
 * academic results: OpenAlex indexes papers, so asking it about a news article
 * or a GitHub issue spends a request to learn nothing. A general web sweep must
 * therefore make ZERO OpenAlex calls, and a scholarly sweep must make them even
 * if the user's category is not literally named "science".
 *
 * Matching on the category NAME alone would be wrong here: a default SearXNG
 * ships both `science` and `scientific publications`, and a user can rename or
 * invent categories freely. So the test is which engines actually sit behind
 * the category — that survives renaming, and it correctly turns hydration off
 * for someone who has disabled every scholarly engine.
 */

import { FETCH_TIMEOUT_MS, SEARXNG_URL } from "./config.ts";

/**
 * Engines whose results OpenAlex can plausibly identify as works.
 *
 * Matched as substrings against the engine name, because SearXNG suffixes
 * variants (`openaire publications`, `google scholar`).
 */
const SCHOLARLY_ENGINES = [
  "arxiv", "pubmed", "openalex", "crossref", "semantic scholar", "google scholar",
  "openaire", "core", "doaj", "springer", "pubchem", "biorxiv", "medrxiv",
  "science open", "base", "dblp", "inspire", "hal", "zenodo", "osti", "pdbe",
];

/** Used only when SearXNG cannot be asked. */
const SCHOLARLY_NAMES = ["science", "scientific publication", "scholar", "academic", "paper"];

interface SearxngEngine {
  name?: string;
  enabled?: boolean;
  categories?: string[];
  /** Whether the engine honours `time_range`. SearXNG DROPS engines that do
      not when one is requested -- see supportsTimeRange below. */
  time_range_support?: boolean;
}

interface SearxngConfig {
  engines?: SearxngEngine[];
}

/**
 * SearXNG's engine table changes only when the user edits settings.yml and
 * restarts the container, so a short cache costs nothing and keeps a 6-question
 * sweep from making six identical loopback calls.
 */
const CACHE_TTL_MS = 5 * 60_000;
let cache: { at: number; engines: SearxngEngine[] } | undefined;

async function engineTable(signal?: AbortSignal): Promise<SearxngEngine[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.engines;
  const res = await fetch(`${SEARXNG_URL}/config`, {
    signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`SearXNG /config returned ${res.status}`);
  const engines = ((await res.json()) as SearxngConfig).engines ?? [];
  cache = { at: Date.now(), engines };
  return engines;
}

/** Splits SearXNG's comma-separated category form. */
function names(category: string): string[] {
  return category.split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
}

/** Clears the cached engine table. Tests only. */
export function resetCategoryCache(): void {
  cache = undefined;
}

function isScholarlyEngine(name: string): boolean {
  const n = name.toLowerCase();
  return SCHOLARLY_ENGINES.some((e) => n.includes(e));
}

/** Every category with at least one scholarly engine behind it. */
export async function scholarlyCategories(signal?: AbortSignal): Promise<Set<string>> {
  const categories = new Set<string>();
  for (const engine of await engineTable(signal)) {
    // `enabled` is the default state of the toggle on SearXNG's preferences
    // page -- a browser-cookie setting -- not whether the engine answers an API
    // search. Measured: openalex reports enabled:false on this instance and
    // still returns results for ?categories=scientific+publications. Gating on
    // it would skip hydration for a category that really is scholarly.
    if (!engine.name || !isScholarlyEngine(engine.name)) continue;
    for (const c of engine.categories ?? []) categories.add(c.toLowerCase());
  }
  return categories;
}

/**
 * Can a time filter do anything for this category selection?
 *
 * This is not a nicety. When `time_range` is set, SearXNG silently DROPS every
 * engine that does not support it -- and if that leaves none, the search
 * returns zero results with no error and no explanation.
 *
 * Measured against the live instance: `scientific publications` returns 50 hits
 * from five engines with no time range, and ZERO with `time_range=year`,
 * because arxiv, crossref, openalex, pubmed and semantic scholar all lack
 * time-range support. A model that volunteers `time_range: "year"` on a
 * scholarly search therefore gets nothing back and no idea why.
 *
 * Never throws. If SearXNG cannot be asked it answers `true`, so an unverified
 * filter is honoured rather than silently discarded.
 */
export async function supportsTimeRange(
  category: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const wanted = new Set(names(category));
  if (wanted.size === 0) return true;
  try {
    return (await engineTable(signal)).some(
      (e) =>
        e.time_range_support === true &&
        (e.categories ?? []).some((c) => wanted.has(c.toLowerCase())),
    );
  } catch {
    return true;
  }
}

/**
 * Should this selection be hydrated against OpenAlex?
 *
 * Accepts SearXNG's own comma-separated category form, so a mixed sweep like
 * "science, news" still hydrates: one scholarly category among several is
 * enough, since the DOIs it surfaces are worth resolving regardless of what
 * else was searched alongside it.
 *
 * Never throws. If SearXNG cannot be reached the research run should still
 * proceed, so this degrades to the name test rather than failing the sweep.
 */
export async function isScholarlyCategory(
  category: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const selected = names(category);
  if (selected.length === 0) return false;
  try {
    const scholarly = await scholarlyCategories(signal);
    return selected.some((n) => scholarly.has(n));
  } catch {
    return selected.some((n) => SCHOLARLY_NAMES.some((s) => n.includes(s)));
  }
}
