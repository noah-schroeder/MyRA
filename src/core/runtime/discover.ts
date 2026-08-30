/**
 * Finding a model when you do not already know what to type.
 *
 * The search box works if you know that "qwen" is a model family. Karen's
 * users are academics, and most of them do not -- they know they want
 * something that summarises a paper or transcribes a seminar. An empty box in
 * front of a registry of half a million repositories is not a search
 * experience, it is an exam.
 *
 * So this supplies **shelves**: named collections built from queries Karen
 * ships, each with a task it expects. Pressing one runs those queries and
 * ranks what comes back. Nothing here runs on its own -- see the note on
 * egress below.
 *
 * Three things were measured before any of it was written.
 *
 * **`downloads` from Hugging Face is a rolling 30-day count, not a lifetime
 * one.** `unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF` reports 12,760,676
 * downloads against 18,171,482 all-time. So "what has been popular lately" is
 * already the default ordering, and the figure can be labelled honestly with
 * its window rather than shown as a bare number.
 *
 * **Sorting by newest is useless.** `sort=createdAt` returns a firehose: the
 * top six results all had zero downloads and at most one like. Recency alone
 * is not a recommendation, so there is no "newest" shelf here.
 *
 * **The popular list needs filtering before it can be shown to this
 * audience.** Merging the five biggest model families and sorting by
 * downloads put six safety-stripped roleplay merges in the top eighteen --
 * `OBLITERATED`, `Uncensored`, `Heretic`, `abliterated`. Karen is used on
 * university-issued laptops by people writing under their own name; surfacing
 * those under a heading that reads as a recommendation is a different kind of
 * problem from a merely bad suggestion. See `isLowQuality`.
 *
 * **On egress.** A shelf is a set of queries that leave this machine, so a
 * shelf that loaded itself when the tab opened would break the promise the
 * search panel makes in so many words -- that nothing is sent until you ask.
 * Every shelf here is therefore inert until pressed. The gain over the search
 * box is that pressing a button labelled "Transcription" requires no
 * vocabulary, not that it happens without asking.
 */

import type { RegistryHit } from "./registry.ts";

export interface Shelf {
  id: string;
  /** What it is called on the button, in the words of what it is for. */
  title: string;
  /** One line under the results, saying what was actually asked. */
  hint: string;
  /**
   * The queries Karen sends, in order. Each is one request to the registry.
   *
   * Kept short deliberately: a shelf is one press and should not turn into
   * eight round trips to somebody's registry.
   */
  queries: string[];
  /**
   * Tasks that belong on this shelf. A result whose task is absent is kept --
   * it is missing metadata, not a mismatch -- and one whose task is present
   * and not listed is dropped.
   *
   * **Inert at the time of writing.** Lemonade's search response carries a
   * `task` field in its schema, but measured against the live daemon it comes
   * back empty on every row, so nothing is currently filtered by it. Kept
   * because the rule is right whenever the daemon does supply it, and because
   * `taskFits` already treats absence as "keep" -- so this costs nothing
   * today and needs no change if that alters. Do not read a shelf's contents
   * as task-filtered.
   */
  tasks?: string[];
}

/**
 * The shelves, with the queries measured rather than guessed.
 *
 * Each query below was run against the registry and its first page read. Two
 * obvious-looking ones are deliberately absent: `llava` returns models from
 * 2023 with four-figure download counts, and `vision` returns a list more than
 * half of which is abliterated merges. Where a category had one query that
 * worked, it gets one query.
 *
 * **There is no transcription shelf, and that is a finding rather than an
 * omission.** Whisper models are not distributed as GGUF: whisper.cpp reads
 * `ggml-*.bin`, and never moved to the GGUF container the way llama.cpp did.
 * Every route was tried against the live registry -- `whisper` returns
 * CTranslate2 builds, `ggml whisper` and `whisper.cpp` return repositories
 * with no GGUF at all, and `whisper gguf` returns large language models with
 * "Whisperer" in the name. `moonshine` and `parakeet` return nothing usable
 * either. A shelf here would be a button that is always empty, so
 * transcription models come from the curated catalogue on the Recommended
 * tab, where they actually are.
 */
export const SHELVES: Shelf[] = [
  {
    id: "popular",
    title: "Popular this month",
    hint: "The most downloaded models of the last 30 days, across the main families.",
    queries: ["qwen3", "llama", "gemma", "mistral", "phi"],
    tasks: ["text-generation", "image-text-to-text"],
  },
  {
    id: "writing",
    title: "Writing and summarising",
    hint: "General-purpose models — drafting, summarising, answering questions.",
    queries: ["qwen3", "gemma", "mistral"],
    tasks: ["text-generation"],
  },
  {
    id: "vision",
    title: "Reading figures and scans",
    hint: "Models that can look at an image — a chart, a scanned page, a screenshot.",
    queries: ["qwen vl", "gemma vl"],
    tasks: ["image-text-to-text"],
  },
  {
    id: "embedding",
    title: "Search across your library",
    hint: "Embedding models, which is how a pile of papers becomes searchable by meaning.",
    queries: ["embed", "nomic"],
    tasks: ["feature-extraction", "sentence-similarity"],
  },
];

/**
 * Model publishers, as names a person recognises.
 *
 * Nobody outside this field types "qwen", but everybody has heard of Google
 * and Meta. The organisation is the one piece of vocabulary this audience
 * already has, so it is the one worth offering as a shortcut.
 *
 * The query is the family name rather than the company's registry handle,
 * because registry search matches repository paths: most Llama GGUF files are
 * published by `unsloth` and `bartowski`, not by `meta-llama`, and searching
 * for the publisher would miss nearly all of them.
 */
export const PUBLISHERS: { label: string; query: string }[] = [
  { label: "Alibaba (Qwen)", query: "qwen3" },
  { label: "Google (Gemma)", query: "gemma" },
  { label: "Meta (Llama)", query: "llama" },
  { label: "Mistral", query: "mistral" },
  { label: "Microsoft (Phi)", query: "phi" },
  { label: "IBM (Granite)", query: "granite" },
  { label: "OpenAI (gpt-oss)", query: "gpt-oss" },
  { label: "Arcee", query: "arcee" },
  { label: "Poolside (Laguna)", query: "poolside" },
  /* `glm`, not `zai`: the family rule again, and this is the case that proves
     it. Searching the handle returns 3 GGUF repositories; searching the
     family returns 14, because the `unsloth` and `ggml-org` builds of GLM do
     not carry "zai" anywhere in the path. */
  { label: "Z.ai (GLM)", query: "glm" },
];

/**
 * Repositories not to put in front of this audience.
 *
 * These are community merges that exist to remove a model's refusals, and
 * they advertise it in the repository name. They are legal, popular, and
 * entirely someone else's business -- the objection is not to their existing
 * but to Karen recommending them unprompted to a researcher on an
 * institutional machine.
 *
 * **This filters shelves, never searches.** Somebody who types "abliterated"
 * has asked a question and gets an answer; a shelf is Karen speaking in its
 * own voice, and that is the only place a judgement like this belongs.
 *
 * Matched against the repository path, which is where the words appear.
 */
const LOW_QUALITY =
  /(uncensored|abliterat|obliterat|heretic|nsfw|roleplay|waifu|horny|degenerate|toxic|erotic)/i;

export function isLowQuality(hit: RegistryHit): boolean {
  return LOW_QUALITY.test(hit.id);
}

/** Whether a result's stated task suits a shelf; absent means "keep". */
export function taskFits(hit: RegistryHit, tasks: string[] | undefined): boolean {
  if (!tasks?.length) return true;
  // Absent is missing metadata, not a mismatch: roughly a third of GGUF
  // repositories set no pipeline tag, and dropping them would empty a shelf.
  if (!hit.task) return true;
  return tasks.includes(hit.task);
}

/**
 * How many rows one repository owner may occupy on a shelf.
 *
 * `unsloth`, `bartowski` and `MaziyarPanahi` quantise nearly everything, so a
 * list ranked by downloads alone becomes a list of THEM. Measured: nine
 * consecutive rows from one owner in a shelf of twenty-four.
 */
const PER_OWNER = 4;

/**
 * Turn several queries' worth of results into one shelf.
 *
 * **Interleaved, not concatenated.** Ranking the merged set purely by download
 * count looked reasonable and read terribly: the first real shelf put ten
 * consecutive Gemma variants in positions three to twelve, then nine Mistral
 * and Phi repositories from a single quantiser. Same-family variants have
 * near-identical download counts, so sorting by that number groups them --
 * and a shelf whose job is to show somebody the landscape instead showed them
 * three products.
 *
 * So each query contributes its best row in turn. The registry has already
 * ordered each response by 30-day downloads, so taking from the front of each
 * keeps "most downloaded" true within every family while spreading the
 * families across the shelf -- which is what "across the main families", the
 * line printed under it, actually claims.
 */
export function buildShelf(
  results: RegistryHit[][],
  shelf: Pick<Shelf, "tasks">,
  limit = 24,
): RegistryHit[] {
  const queues = results.map((hits) =>
    hits.filter(
      (hit) => hit.hasGguf && !isLowQuality(hit) && taskFits(hit, shelf.tasks),
    ),
  );

  const out: RegistryHit[] = [];
  const taken = new Set<string>();
  const byOwner = new Map<string, number>();
  const at = new Array<number>(queues.length).fill(0);

  /* Round-robin until every queue is spent or the shelf is full. Two passes
     are not needed: a row skipped for the owner cap is skipped for good, or
     the cap would only delay the clustering it exists to prevent. */
  for (let moved = true; moved && out.length < limit; ) {
    moved = false;
    for (let q = 0; q < queues.length && out.length < limit; q += 1) {
      const queue = queues[q]!;
      while (at[q]! < queue.length) {
        const hit = queue[at[q]!]!;
        at[q]! += 1;
        if (taken.has(hit.id)) continue;
        const owner = ownerOf(hit.id);
        if ((byOwner.get(owner) ?? 0) >= PER_OWNER) continue;
        taken.add(hit.id);
        byOwner.set(owner, (byOwner.get(owner) ?? 0) + 1);
        out.push(hit);
        moved = true;
        break;
      }
    }
  }
  return out;
}

/** `unsloth` from `unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF`. */
function ownerOf(id: string): string {
  const cut = id.indexOf("/");
  return (cut === -1 ? id : id.slice(0, cut)).toLowerCase();
}

/**
 * How many were set aside, so the filtering can be admitted rather than hidden.
 *
 * A shelf that quietly drops a fifth of what it fetched is making an editorial
 * choice on somebody's behalf without telling them. Saying so costs one line.
 */
export function countFiltered(results: RegistryHit[][]): number {
  const seen = new Set<string>();
  let dropped = 0;
  for (const hits of results) {
    for (const hit of hits) {
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      if (isLowQuality(hit)) dropped += 1;
    }
  }
  return dropped;
}

/**
 * The download count with its window attached.
 *
 * "13M" invites the reading "thirteen million people use this", when what the
 * registry actually reports is thirty days of traffic including every
 * automated pull. The window is the part that makes the number mean anything.
 */
export function describeDownloads(n: number | undefined): string {
  if (n === undefined) return "—";
  return `${compact(n)} in the last 30 days`;
}

/** `12.8M`, `334k`, `47`. */
export function compact(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n >= 1_000_000) {
    /* One decimal all the way up, because this column exists to be compared
       down and the models that reach eight figures are exactly the ones a
       person is choosing between: 12.8M against 8.8M is a difference, and
       rounding both to whole millions throws it away. The trailing ".0" goes,
       so a round number reads as one. */
    const m = (n / 1_000_000).toFixed(1);
    return `${m.endsWith(".0") ? m.slice(0, -2) : m}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}
