/**
 * What a hosted model costs, when the provider says so.
 *
 * Only when it says so. There is no table of prices in this app and there must
 * not be: a figure Karen remembered would be wrong the week a provider changed
 * it, and a wrong price is worse than no price -- it is the number somebody
 * budgets a grant against. Everything here comes from the endpoint's own model
 * listing, at the moment it was asked, and anything Karen cannot read is shown
 * as nothing rather than guessed at.
 *
 * Two shapes are read, because two are in use: OpenRouter's `pricing.prompt` /
 * `pricing.completion`, in dollars per token as strings, and the
 * `input_cost_per_token` / `output_cost_per_token` numbers that LiteLLM-style
 * proxies attach. Both are per token; both are stored here per MILLION tokens,
 * which is the unit every provider quotes in and the only one at which the
 * numbers are legible.
 */

export interface ModelPrice {
  /** US dollars per million input tokens, as the provider reported it. */
  input: number;
  /** US dollars per million output tokens. */
  output: number;
}

const PER_MILLION = 1_000_000;

/** A price field, which may be a string, a number, or nonsense. */
function rate(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  /* Negative is not a discount, it is a broken feed. Zero is real: several
     gateways serve free models and say so with a zero. */
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * The price on one entry of a `/v1/models` listing, if there is one.
 *
 * Both halves are required. A listing with an input price and no output price
 * is one Karen cannot state the cost of, and half a price shown as a whole one
 * is exactly the kind of confident wrongness this module exists to avoid.
 */
export function priceOf(entry: unknown): ModelPrice | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const row = entry as Record<string, unknown>;
  const pricing = (row["pricing"] ?? {}) as Record<string, unknown>;

  const input =
    rate(pricing["prompt"]) ?? rate(pricing["input"]) ?? rate(row["input_cost_per_token"]);
  const output =
    rate(pricing["completion"]) ?? rate(pricing["output"]) ?? rate(row["output_cost_per_token"]);
  if (input === undefined || output === undefined) return undefined;
  return { input: input * PER_MILLION, output: output * PER_MILLION };
}

/** Every priced model in a listing, keyed by id. */
export function pricesFrom(entries: unknown): Record<string, ModelPrice> {
  if (!Array.isArray(entries)) return {};
  const out: Record<string, ModelPrice> = {};
  for (const entry of entries) {
    const id = (entry as { id?: unknown })?.id;
    if (typeof id !== "string" || !id) continue;
    const price = priceOf(entry);
    if (price) out[id] = price;
  }
  return out;
}

/**
 * One figure, at a readable number of decimals.
 *
 * Prices span four orders of magnitude -- a cent per million to twenty dollars
 * -- so a fixed two decimals would print "$0.00" for a model that is cheap
 * rather than free, which is a different fact.
 */
export function money(amount: number): string {
  if (amount === 0) return "$0";
  if (amount < 0.01) return `$${amount.toPrecision(2)}`;
  if (amount < 1) return `$${amount.toFixed(2)}`;
  return `$${amount.toFixed(2).replace(/\.00$/, "")}`;
}

/** "$3 / $15" — in, then out, the order every provider quotes them in. */
export function priceLabel(price: ModelPrice | undefined): string {
  if (!price) return "";
  if (price.input === 0 && price.output === 0) return "free";
  return `${money(price.input)} / ${money(price.output)}`;
}

/** The whole sentence, for a tooltip: what the numbers are and where from. */
export function priceTitle(price: ModelPrice | undefined): string {
  if (!price) return "";
  if (price.input === 0 && price.output === 0) {
    return "This provider reported no charge for this model when its models were last fetched.";
  }
  return (
    `${money(price.input)} per million input tokens and ${money(price.output)} per million ` +
    "output tokens, in US dollars, as this provider reported it when its models were last " +
    "fetched. Karen keeps no price list of its own."
  );
}

/** Kept small on purpose: a price list is a cache, not a record. */
export const MAX_PRICES = 500;

export function parsePrices(raw: unknown): Record<string, ModelPrice> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, ModelPrice> = {};
  let n = 0;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_PRICES) break;
    const row = value as { input?: unknown; output?: unknown };
    const input = rate(row?.input);
    const output = rate(row?.output);
    if (input === undefined || output === undefined) continue;
    out[id] = { input, output };
    n += 1;
  }
  return out;
}
