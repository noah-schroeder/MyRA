/**
 * Runtime configuration, read fresh rather than cached.
 *
 * The GUI writes research.json; the extension reads it at the moment a tool
 * runs, so changing the control in the app takes effect on the very next call
 * with no restart and no stale copy in memory.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** OpenAlex's "polite pool" is faster and more generously rate limited. */
export const OPENALEX_MAILTO = process.env["KAREN_OPENALEX_MAILTO"] ?? "";

export const FETCH_TIMEOUT_MS = 20_000;

/**
 * How long to wait on a search backend, as opposed to a page.
 *
 * Shorter than `FETCH_TIMEOUT_MS` because these are two different waits. A
 * page fetch is the thing you asked for, and a slow publisher is worth twenty
 * seconds. A search is a fan-out across backends where the slowest one sets
 * the pace for all of them, and a backend that is down costs that wait on
 * every single query.
 *
 * Measured: OpenAlex answers a 50-result query in roughly 900ms. Ten seconds
 * is an order of magnitude of headroom for a backend that is working, and
 * halves what an outage costs.
 */
export const SEARCH_TIMEOUT_MS = 10_000;
export const MAX_PAGE_BYTES = 3_000_000;
export const DEFAULT_PAGE_CHARS = 8_000;
export const FETCH_CONCURRENCY = 4;

/**
 * Where completed and in-flight research runs are kept.
 *
 * A function for the same reason as researchConfigPath(): reading the
 * environment once at module load freezes it, and anything that changes the
 * environment afterwards would silently keep writing to the old location.
 */
export function researchRoot(): string {
  return (
    process.env["KAREN_RESEARCH_ROOT"] ??
    join(process.env["HOME"] ?? homedir(), "Documents", "karen", "research")
  );
}

/**
 * Resolved per call, not once at module load.
 *
 * Module-level state here is a trap: the path would be frozen at import time,
 * so anything that changes the environment afterwards -- tests, a relaunch with
 * different settings -- would silently keep reading the old file.
 */
export function researchConfigPath(): string {
  return (
    process.env["KAREN_RESEARCH_CONFIG"] ??
    join(process.env["HOME"] ?? homedir(), ".config", "karen", "research.json")
  );
}

/**
 * What the research bar in the GUI controls, and nothing else.
 *
 * The embeddings endpoint used to live here too, which meant it had two homes:
 * Settings wrote settings.json and the pipeline read research.json, so the
 * endpoint the user configured was never the endpoint the pipeline looked for
 * and the ranking stage silently never ran. Endpoints belong in Settings with
 * every other endpoint; this file is only the search controls.
 */
export interface ResearchConfig {
  mode: "off" | "web" | "deep";
  /** Where to search: "science" for the literature, "general" for the web. */
  category: string;
  timeRange?: string;
}

/**
 * Categories this build can actually search.
 *
 * "general" is a real capability with no provider in this build -- the GUI
 * offers it disabled, and `deep_research` is gated on whether a general sweep
 * is possible at all. It must therefore never be the *stored* value: a run
 * would ask for a category no provider serves and fail several seconds in,
 * with an error about providers rather than about a setting.
 */
const SUPPORTED_CATEGORIES = new Set(["science"]);
const FALLBACK_CATEGORY = "science";

export const DEFAULT_RESEARCH: ResearchConfig = { mode: "off", category: FALLBACK_CATEGORY };

export function readResearchConfig(path = researchConfigPath()): ResearchConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ResearchConfig>;
    // Rebuilt field by field rather than spread, so a malformed file cannot
    // inject anything -- which means every field must be listed HERE or it is
    // silently dropped.
    return {
      mode: parsed.mode === "web" || parsed.mode === "deep" ? parsed.mode : "off",
      // Coerced, not just defaulted: "general" was the default for a while, so
      // existing installs have it written to disk and would keep it forever.
      category:
        typeof parsed.category === "string" && SUPPORTED_CATEGORIES.has(parsed.category)
          ? parsed.category
          : FALLBACK_CATEGORY,
      ...(typeof parsed.timeRange === "string" ? { timeRange: parsed.timeRange } : {}),
    };
  } catch {
    // No file yet, or corrupt: behave exactly as before the GUI existed rather
    // than guessing at a mode that changes which tools the model can reach.
    return DEFAULT_RESEARCH;
  }
}

/**
 * The category a search should actually use.
 *
 * The GUI selection WINS over whatever the model passed. The control exists so
 * the user can say "search science this time"; a setting the model can quietly
 * override would not be a setting.
 */
export function effectiveCategory(modelChoice: string | undefined, fallback: string): string {
  const cfg = readResearchConfig();
  if (cfg.mode !== "off" && cfg.category) return cfg.category;
  return modelChoice ?? fallback;
}

/**
 * The time range a search should actually use.
 *
 * Same rule as effectiveCategory, and for the same reason: the GUI has a time
 * range control, so the GUI decides. This is not symmetry for its own sake --
 * a model that volunteers `time_range: "year"` on a scholarly category gets
 * ZERO results back: v1's SearXNG dropped every engine lacking time-range
 * support, and no scholarly engine had it. That failure looked exactly like a
 * broken search -- eight queries, eight empty answers, no error. providers.ts
 * declares the capability per provider now, so an unsupported filter is
 * reported and not sent.
 *
 * "any time" in the GUI is a real choice and returns "", clearing the model's.
 */
export function effectiveTimeRange(modelChoice: string | undefined): string {
  const cfg = readResearchConfig();
  if (cfg.mode !== "off") return cfg.timeRange ?? "";
  return modelChoice ?? "";
}

/** Splits the stored form into distinct, trimmed, non-empty category names. */
export function parseCategories(value: string): string[] {
  const seen = new Set<string>();
  for (const raw of value.split(",")) {
    const name = raw.trim();
    if (name) seen.add(name);
  }
  return [...seen];
}
