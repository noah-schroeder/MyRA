/**
 * A repository id, read the way a person would say it.
 *
 * `unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF` is a filename. It carries four
 * separate facts jammed together -- who built it, what the model is, how big it
 * is, and what format it is in -- and a list of forty of them is a list nobody
 * scans. This file pulls the facts apart so a row can put the name first and the
 * plumbing last.
 *
 * ## Where the size comes from, and why it is not exact
 *
 * The registry will give an exact parameter count for a whole page:
 * `expand[]=gguf` returns `{total, architecture, context_length}` and, measured,
 * 100 of 100 rows carried it. It also returns each row's full Jinja chat
 * template, which takes the page from **50 kB to 857 kB** -- and MyRA makes up
 * to eight such requests when publishers are crossed. Seven megabytes of
 * somebody else's bandwidth for a number that is already written on the tin is
 * not a trade worth making.
 *
 * So the size is read off the name. Measured against those same 100
 * repositories, the parser below agreed with the registry's own figure 62
 * times, disagreed 3 times, and declined to answer 35 times. All three
 * disagreements were `-MTP` repositories, which are handled by name below.
 *
 * That is why this returns "what the name says" rather than "how big it is",
 * and why the exact figure and the fits-here verdict stay on the model card,
 * where the registry has reported real bytes. A row and a card can then differ
 * in precision without ever contradicting each other.
 */

import { shortModelName } from "./foreign.ts";

/**
 * A number of parameters the repository's name claims, if it claims one.
 *
 * The rules, each of which a real repository needed:
 *
 *   - **The decimal point survives.** `nemotron-3.5-asr-streaming-0.6b` is a
 *     600-million-parameter model. A first draft normalised separators before
 *     matching, read `0.6b` as `6b`, and made it ten times too big -- which is
 *     the sort of error that is invisible until somebody tries to load it.
 *   - **A digit only counts at a word boundary.** `v3`, `Qwen3`, `IQ2_M` and
 *     `SmolLM2` all contain a digit next to a letter, and none of them is a
 *     size. Requiring a non-alphanumeric before the number and a `B` or `M`
 *     immediately after it is what separates `Llama-3.2-1B` (1B) from its own
 *     version number.
 *   - **The first size wins.** `Qwen3-Coder-30B-A3B` is a mixture-of-experts
 *     model: 30B total, 3B active per token. The total is what sizes the
 *     download, which is the question a list is answering.
 *   - **`-MTP` repositories are refused.** They hold a multi-token-prediction
 *     module for a parent model and are named after that parent, so the name
 *     says 27B or 35B where the contents are half a billion. All three of the
 *     parser's measured disagreements were this.
 *
 * `8x7B` and its relatives return nothing rather than a guess: the total for a
 * sparse mixture is not the product, and saying so wrongly is worse than saying
 * nothing.
 */
export function parameterCount(id: string): number | undefined {
  const leaf = (id.split("/").pop() ?? id).replace(/\.gguf$/i, "");
  if (/(^|[^A-Za-z0-9])MTP([^A-Za-z0-9]|$)/i.test(leaf)) return undefined;
  // `8x7B`, `2x8B`: a sparse mixture, whose total is not the product.
  if (/(^|[^A-Za-z0-9])\d+\s*x\s*\d+(?:\.\d+)?\s*[BbMm]([^A-Za-z0-9]|$)/i.test(leaf)) {
    return undefined;
  }

  const match = /(?:^|[^A-Za-z0-9])(\d+(?:\.\d+)?)\s*([BbMm])(?![A-Za-z0-9])/.exec(leaf);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const scale = match[2]?.toLowerCase() === "b" ? 1e9 : 1e6;
  const total = value * scale;
  /* A sanity floor and ceiling. Below a million the number was almost certainly
     something else -- a year, a version -- and above two trillion nothing
     exists, so either way the honest answer is to say nothing. */
  return total >= 1e6 && total <= 2e12 ? total : undefined;
}

/** `30B`, `1.7B`, `135M` -- as the name writes it, not rounded away. */
export function formatParameters(total: number): string {
  if (total >= 1e9) {
    const billions = total / 1e9;
    return `${billions >= 10 ? Math.round(billions) : Number(billions.toFixed(1))}B`;
  }
  return `${Math.round(total / 1e6)}M`;
}

/** The size a row should print, or nothing when the name does not say. */
export function parameterLabel(id: string): string | undefined {
  const total = parameterCount(id);
  return total === undefined ? undefined : formatParameters(total);
}

/**
 * The model's name, with the separators a filename needs taken back out.
 *
 * `shortModelName` already drops the publisher path and the quantisation
 * suffix; what is left is still hyphenated, and a column of hyphenated mono
 * type is what made the old list read as a directory listing. Case is left
 * exactly as the publisher wrote it -- `LFM2.5`, `gpt-oss`, `SmolLM2` are not
 * improved by title casing, and getting them wrong looks careless in a way the
 * raw name does not.
 */
export function readableName(id: string): string {
  return shortModelName(id).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim() || id;
}

/** `unsloth` from `unsloth/Qwen3-8B-GGUF`, so it can be set apart from the name. */
export function publisherOf(id: string): string | undefined {
  const at = id.indexOf("/");
  return at > 0 ? id.slice(0, at) : undefined;
}
