/**
 * What a quantisation name means, in words somebody can act on.
 *
 * `Qwen3-8B-Q4_K_M.gguf` and `Qwen3-8B-Q8_0.gguf` differ by four gigabytes and
 * a decision, and the name says which is which only to someone who already
 * knows. This app is for researchers who have no reason to have learnt the
 * scheme, and "pick one of these eleven files" is not a question they should be
 * asked without being told what the answer costs.
 *
 * The notes are deliberately comparative rather than numeric. Published
 * perplexity figures are model-specific and move with every llama.cpp release;
 * "smaller and slightly worse than the one above it" is both stable and the
 * only part of the answer that affects the choice.
 *
 * Ordering lives in `quantRank` in [fit.ts](./fit.ts) and is not repeated here:
 * one table says which to recommend, this one says what they are.
 */

export interface Quant {
  /** The family exactly as it appears in a filename: `Q4_K_M`. */
  id: string;
  /** A few words for a narrow column. */
  short: string;
  /** One sentence. */
  note: string;
}

/*
 * Longest names first: the lookup is a prefix scan over a filename, and
 * `Q4_K_M` contains `Q4_K`, which contains `Q4`. Sorting by length at the point
 * of use would work too and would hide the reason, so the order is the table's.
 */
const QUANTS: Quant[] = [
  {
    id: "Q4_K_M",
    short: "Four-bit, balanced",
    note: "The usual choice. About a quarter the size of the original weights, and the quality cost is small enough that most people never notice it.",
  },
  {
    id: "Q4_K_S",
    short: "Four-bit, smaller",
    note: "A little smaller than Q4_K_M and a little worse. Worth it only when Q4_K_M does not fit.",
  },
  {
    id: "Q5_K_M",
    short: "Five-bit, balanced",
    note: "Closer to the original than four-bit, at roughly a fifth more memory. A good step up if you have the room.",
  },
  {
    id: "Q5_K_S",
    short: "Five-bit, smaller",
    note: "Between Q4_K_M and Q5_K_M in both size and quality.",
  },
  {
    id: "Q8_K_XL",
    short: "Eight-bit, mixed",
    note: "Eight-bit with the most sensitive parts kept higher still. The largest quantised build, and no better than Q8_0 for ordinary use.",
  },
  {
    id: "Q6_K_L",
    short: "Six-bit, mixed",
    note: "Six-bit with the most sensitive parts kept at higher precision: a little larger than Q6_K, and a little better.",
  },
  {
    id: "Q5_K_XL",
    short: "Five-bit, mixed",
    note: "Five-bit with the most sensitive parts kept at higher precision: a little larger than Q5_K_M, and a little better.",
  },
  {
    id: "Q5_K_L",
    short: "Five-bit, mixed",
    note: "Five-bit with the most sensitive parts kept at higher precision: a little larger than Q5_K_M, and a little better.",
  },
  {
    id: "Q4_K_XL",
    short: "Four-bit, mixed",
    note: "Four-bit with the most sensitive parts kept at higher precision: a little larger than Q4_K_M, and a little better. A good first choice where it fits.",
  },
  {
    id: "Q4_K_L",
    short: "Four-bit, mixed",
    note: "Four-bit with the most sensitive parts kept at higher precision: a little larger than Q4_K_M, and a little better. A good first choice where it fits.",
  },
  {
    id: "Q3_K_XL",
    short: "Three-bit, mixed",
    note: "Three-bit with the most sensitive parts kept at higher precision: larger than Q3_K_M and noticeably better, though still below four-bit.",
  },
  {
    id: "Q2_K_XL",
    short: "Two-bit, mixed",
    note: "Two-bit with the most sensitive parts kept at higher precision. Better than plain Q2_K, and still a build for models that would not otherwise fit.",
  },
  {
    id: "Q2_K_L",
    short: "Two-bit, mixed",
    note: "Two-bit with the most sensitive parts kept at higher precision. Better than plain Q2_K, and still a build for models that would not otherwise fit.",
  },
  {
    id: "Q3_K_L",
    short: "Three-bit, larger",
    note: "The best of the three-bit builds. Noticeably weaker than four-bit; for models that would otherwise not fit at all.",
  },
  {
    id: "Q3_K_M",
    short: "Three-bit",
    note: "Small enough to run a model a size class up, at a quality cost you will see in longer answers.",
  },
  {
    id: "Q3_K_S",
    short: "Three-bit, smaller",
    note: "Smaller again, and weaker again. A last resort before Q2.",
  },
  {
    id: "IQ4_XS",
    short: "Four-bit, newer scheme",
    note: "A newer four-bit format, slightly smaller than Q4_K_S at similar quality. Needs a recent engine build.",
  },
  {
    id: "IQ4_NL",
    short: "Four-bit, newer scheme",
    note: "Like IQ4_XS with a different rounding rule; sizes and quality are close. Needs a recent engine build.",
  },
  {
    id: "IQ3_XXS",
    short: "Three-bit, newer scheme",
    note: "Very small. Built with an importance matrix, so it holds up better than plain three-bit, but it is still three bits.",
  },
  {
    id: "IQ3_XS",
    short: "Three-bit, newer scheme",
    note: "Very small, and better than plain Q3 at the same size. Still a clear step down from four-bit.",
  },
  {
    id: "IQ1_M",
    short: "One-bit, newer scheme",
    note: "About one bit per weight. The smallest build that exists, for models far beyond this machine otherwise; expect it to lose the thread.",
  },
  {
    id: "IQ1_S",
    short: "One-bit, smallest",
    note: "The smallest build of all. Worth trying only when nothing else will load at all.",
  },
  {
    id: "IQ2_XXS",
    short: "Two-bit, newer scheme",
    note: "The smallest thing worth running, and only for models far too large for this machine otherwise.",
  },
  {
    id: "IQ2_XS",
    short: "Two-bit, newer scheme",
    note: "Extremely small. Expect the model to lose track of instructions.",
  },
  {
    id: "Q2_K",
    short: "Two-bit",
    note: "The smallest common build. The drop in quality is obvious, not subtle.",
  },
  {
    id: "Q6_K",
    short: "Six-bit",
    note: "Very close to the original weights. Half again the size of four-bit, for a difference most tasks will not show.",
  },
  {
    id: "Q8_0",
    short: "Eight-bit",
    note: "Effectively indistinguishable from the original, and about twice the size of a four-bit build.",
  },
  {
    id: "Q4_0",
    short: "Four-bit, older scheme",
    note: "The original four-bit format. Q4_K_M is the same size and better; take this only if it is all there is.",
  },
  {
    id: "Q4_1",
    short: "Four-bit, older scheme",
    note: "An older four-bit format, superseded by the K-quants above.",
  },
  {
    id: "Q5_0",
    short: "Five-bit, older scheme",
    note: "An older five-bit format. Q5_K_M is the same size and better.",
  },
  {
    id: "Q5_1",
    short: "Five-bit, older scheme",
    note: "An older five-bit format, superseded by the K-quants above.",
  },
  {
    id: "BF16",
    short: "Original weights",
    note: "Not quantised at all. Four times the size of a four-bit build, and no better for ordinary use.",
  },
  {
    id: "F16",
    short: "Original weights",
    note: "Not quantised at all. Four times the size of a four-bit build, and no better for ordinary use.",
  },
  {
    id: "F32",
    short: "Full precision",
    note: "The largest possible file, eight times a four-bit build. Nothing here needs it.",
  },
];

/**
 * The quantisation a filename or variant name describes, if any.
 *
 * Case-insensitive and anchored on a word boundary, because these names appear
 * mid-filename (`Qwen3-8B-Q4_K_M.gguf`) and also as bare variant labels
 * (`Q4_K_M`) depending on which endpoint the list came from. The boundary is
 * what stops `IQ4_XS` from being read as `Q4`.
 */
export function quantOf(name: string): Quant | undefined {
  const upper = name.toUpperCase();
  return QUANTS.find((q) => new RegExp(`(^|[^A-Z0-9])${q.id}([^A-Z0-9]|$)`).test(upper));
}

/**
 * Unsloth's `UD-` prefix, which is a real difference and not decoration.
 *
 * `UD-Q4_K_XL` and `Q4_K_XL` are different files at different sizes, so the
 * prefix must never be flattened away in a name -- and a row that says nothing
 * about it leaves somebody guessing why there are two four-bit builds.
 */
export function isDynamic(name: string): boolean {
  return /(^|[^A-Za-z0-9])UD-/i.test(name);
}
