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

export const SEARXNG_URL =
  (process.env["KAREN_SEARXNG_URL"] ?? "http://127.0.0.1:8888").replace(/\/$/, "");

/** OpenAlex's "polite pool" is faster and more generously rate limited. */
export const OPENALEX_MAILTO = process.env["KAREN_OPENALEX_MAILTO"] ?? "";

export const FETCH_TIMEOUT_MS = 20_000;
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

/** Where embeddings are served — usually a different process than chat. */
export interface EmbeddingsConfig {
  baseUrl: string;
  /** Name of the env var holding the key. Never the key itself. */
  envVar: string;
  model: string;
}

export interface ResearchConfig {
  mode: "off" | "web" | "deep";
  /** One or more SearXNG categories, comma-separated (SearXNG's own format). */
  category: string;
  timeRange?: string;
  embeddings?: EmbeddingsConfig;
}

export const DEFAULT_RESEARCH: ResearchConfig = { mode: "off", category: "general" };

export function readResearchConfig(path = researchConfigPath()): ResearchConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ResearchConfig>;
    const e = parsed.embeddings;
    return {
      mode: parsed.mode === "web" || parsed.mode === "deep" ? parsed.mode : "off",
      category: typeof parsed.category === "string" && parsed.category ? parsed.category : "general",
      ...(typeof parsed.timeRange === "string" ? { timeRange: parsed.timeRange } : {}),
      // Rebuilt field by field rather than spread, so a malformed file cannot
      // inject anything -- which means every field must be listed HERE or it is
      // silently dropped.
      ...(e && typeof e.baseUrl === "string" && e.baseUrl && typeof e.model === "string" && e.model
        ? {
            embeddings: {
              baseUrl: e.baseUrl,
              envVar: typeof e.envVar === "string" && e.envVar ? e.envVar : "KAREN_EMBED_KEY",
              model: e.model,
            },
          }
        : {}),
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
 * ZERO results back, because SearXNG drops every engine lacking time-range
 * support and no scholarly engine has it. That failure looked exactly like a
 * broken search: eight queries, eight empty answers, no error.
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
