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

import { isCollectionKey } from "../library/zotero.ts";

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
export type ResearchMode = "off" | "assistant" | "library" | "web" | "deep";

/**
 * One ladder, not five controls: how far Karen may reach on its own.
 *
 * Each rung is a superset of the one below, which is what lets a single control
 * express the whole question -- and, more usefully, what lets every gate be
 * written as "at least this far" instead of a list of modes that has to be
 * revisited each time a rung appears.
 *
 *   off        nothing at all. No tool is sent in the schema, so the answer is
 *              the model's own and there is nothing for it to call.
 *   assistant  the documents folder. Local, jailed, no network.
 *   library    + the user's own Zotero, over its loopback API. Still no network:
 *              this rung reaches further into THIS MACHINE, not outward.
 *   web        + searching the literature. The first rung that leaves the box.
 *   deep       + the multi-stage pipeline, instead of a single lookup.
 *
 * IN ORDER. `reaches` indexes this array, so the order is the semantics.
 */
export const RESEARCH_MODES: readonly ResearchMode[] = [
  "off", "assistant", "library", "web", "deep",
];

/**
 * Does this mode reach at least as far as that one?
 *
 * The whole reason gates are written this way. `fetch_page` was once gated on
 * `mode !== "off"`, which was correct for exactly as long as there were two
 * modes: adding "assistant" would have handed the web to the one rung that must
 * not have it, and adding "library" would have done it again. A rank comparison
 * cannot develop that bug, because a new rung has to be placed in the ladder
 * before it can be placed anywhere else.
 */
export function reaches(mode: ResearchMode, atLeast: ResearchMode): boolean {
  return RESEARCH_MODES.indexOf(mode) >= RESEARCH_MODES.indexOf(atLeast);
}

/**
 * Is this EXACTLY that rung -- deliberately, not by accident?
 *
 * Almost every gate wants `reaches`. Two do not: the searching rungs are
 * exclusive rather than cumulative, because narrowing the agent to the one
 * search tool that matches is the point of having two of them. "Quick" must not
 * be able to start a ten-minute report, and "Deep" must not be able to quietly
 * do a shallow lookup instead of the one that was asked for.
 *
 * That is a real requirement, and `===` expresses it correctly. It is also
 * indistinguishable, at a glance, from the `===` somebody writes without having
 * thought about rungs at all -- which is the bug this ladder exists to prevent.
 * So the deliberate one says so, and a bare mode literal anywhere else in the
 * codebase is now a thing to look at rather than a thing to read past.
 */
export function exactly(mode: ResearchMode, rung: ResearchMode): boolean {
  return mode === rung;
}

/**
 * Whether this mode may reach the NETWORK.
 *
 * Deliberately not "may search anything": the library rung searches, and it
 * searches loopback. This is the egress question, and it is the one that has to
 * stay exact.
 */
export function searches(mode: ResearchMode): boolean {
  return reaches(mode, "web");
}

/** Whether the user's own Zotero library is readable in this mode. */
export function readsLibrary(mode: ResearchMode): boolean {
  return reaches(mode, "library");
}

/** Whether the local document tools are in the schema. */
export function readsDocuments(mode: ResearchMode): boolean {
  return reaches(mode, "assistant");
}

export interface ResearchConfig {
  mode: ResearchMode;
  /** Where to search: "science" for the literature, "general" for the web. */
  category: string;
  timeRange?: string;
  /**
   * Which Zotero collection the library rung searches. Absent means all of it.
   *
   * `| undefined` on both, and not merely optional, because clearing this has
   * to be expressible: under exactOptionalPropertyTypes a bare optional cannot
   * be assigned undefined, so "back to the whole library" would be unsayable.
   */
  collection?: string | undefined;
  /**
   * The chosen collection's name, for display and for saying what was searched.
   *
   * Stored beside the key rather than looked up, so the control still reads
   * correctly when Zotero is closed -- which is most of the time, and exactly
   * when a silently blank control would look like a lost setting.
   */
  collectionName?: string | undefined;
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

/**
 * The shape version of research.json.
 *
 * Bumped when "off" changed meaning. It used to mean "do not search", and the
 * three document tools stayed in the schema regardless; it now means no tools
 * at all. Every install on disk has `mode: "off"` written into it -- that was
 * the default -- so reading those literally would take document writing away
 * from everyone who had never touched the control. A file with no version is
 * therefore read under the OLD meaning, and only a file this Karen wrote can
 * say "off" and be taken at its word.
 */
const CONFIG_VERSION = 2;

/**
 * Starts one rung up from nothing.
 *
 * "off" is not the safe default it looks like. The document tools are local and
 * jailed, so nothing egresses at "assistant" that would not egress at "off" --
 * the privacy question is entirely about "web" and "deep", and those stay off
 * either way. What "off" costs instead is Karen's other half: asked to write
 * something up, it would have to say it cannot.
 */
export const DEFAULT_RESEARCH: ResearchConfig = { mode: "assistant", category: FALLBACK_CATEGORY };

/**
 * Read one stored mode, under the meaning the file was written with.
 *
 * `versioned` is the whole point: an unversioned "off" was a request not to
 * search, not a request to have no tools, and is honoured as the former.
 */
function storedMode(value: unknown, versioned: boolean): ResearchMode {
  if (value === "off") return versioned ? "off" : "assistant";
  /* Checked against the ladder rather than a hand-written list, so a rung added
     above cannot be silently coerced away here -- which is exactly what would
     happen to a stored "library" if this still enumerated three names. */
  if (typeof value === "string" && (RESEARCH_MODES as readonly string[]).includes(value)) {
    return value as ResearchMode;
  }
  return DEFAULT_RESEARCH.mode;
}

/**
 * The collection scope, or nothing at all.
 *
 * The two fields stand or fall together: a key with no name would give the user
 * a control that says nothing, and a name with no key would say it had searched
 * somewhere it had not. The key is shape-checked here as well as at the client,
 * because this file is what a hand-edited research.json reaches first.
 */
function collectionFields(key: unknown, name: unknown): Record<string, string> {
  if (!isCollectionKey(key)) return {};
  const label = typeof name === "string" ? name.trim().slice(0, 200) : "";
  if (!label) return {};
  return { collection: key, collectionName: label };
}

export function readResearchConfig(path = researchConfigPath()): ResearchConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ResearchConfig> & { v?: unknown };
    // Rebuilt field by field rather than spread, so a malformed file cannot
    // inject anything -- which means every field must be listed HERE or it is
    // silently dropped.
    return {
      mode: storedMode(parsed.mode, parsed.v === CONFIG_VERSION),
      // Coerced, not just defaulted: "general" was the default for a while, so
      // existing installs have it written to disk and would keep it forever.
      category:
        typeof parsed.category === "string" && SUPPORTED_CATEGORIES.has(parsed.category)
          ? parsed.category
          : FALLBACK_CATEGORY,
      ...(typeof parsed.timeRange === "string" ? { timeRange: parsed.timeRange } : {}),
      ...collectionFields(parsed.collection, parsed.collectionName),
    };
  } catch {
    // No file yet, or corrupt: behave exactly as before the GUI existed rather
    // than guessing at a mode that changes which tools the model can reach.
    return DEFAULT_RESEARCH;
  }
}

/**
 * Build the object that gets written to research.json.
 *
 * Lives beside the reader deliberately. These two used to sit in different
 * files -- the reader here, the writer in the IPC handler -- each with a
 * comment telling the next person to keep them in step, which is the kind of
 * instruction that holds right up until someone adds a field. Now a field that
 * survives a round trip is one function away from a field that does not.
 *
 * Always stamped with the current version, so a mode this Karen wrote is read
 * back at face value: only a file from before the rungs existed gets its "off"
 * reinterpreted.
 */
export function serializeResearchConfig(next: unknown): Record<string, unknown> {
  const cfg = (next ?? {}) as Partial<ResearchConfig>;
  return {
    v: CONFIG_VERSION,
    mode: storedMode(cfg.mode, true),
    category:
      typeof cfg.category === "string" && SUPPORTED_CATEGORIES.has(cfg.category)
        ? cfg.category
        : FALLBACK_CATEGORY,
    ...(typeof cfg.timeRange === "string" ? { timeRange: cfg.timeRange } : {}),
    ...collectionFields(cfg.collection, cfg.collectionName),
  };
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
  if (searches(cfg.mode) && cfg.category) return cfg.category;
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
  if (searches(cfg.mode)) return cfg.timeRange ?? "";
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
