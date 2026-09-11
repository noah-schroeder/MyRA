/**
 * Prices, which must be the provider's own or absent.
 *
 * The failure to avoid is a confident wrong number: somebody budgets against
 * these. So every path either reports what the endpoint said or reports
 * nothing.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  money, parsePrices, priceLabel, priceOf, pricesFrom, priceTitle,
} from "../src/core/pricing.ts";

describe("reading a price off a model listing", () => {
  it("reads OpenRouter's strings, per token, and states them per million", () => {
    const price = priceOf({ id: "x", pricing: { prompt: "0.000003", completion: "0.000015" } });
    assert.deepEqual(price, { input: 3, output: 15 });
  });

  it("reads the per-token numbers a LiteLLM-style proxy attaches", () => {
    const price = priceOf({ id: "x", input_cost_per_token: 0.0000005, output_cost_per_token: 0.0000015 });
    assert.deepEqual(price, { input: 0.5, output: 1.5 });
  });

  it("reports nothing when only half the price is there", () => {
    assert.equal(priceOf({ id: "x", pricing: { prompt: "0.000003" } }), undefined);
  });

  it("reports nothing rather than guessing at a listing with no prices", () => {
    assert.equal(priceOf({ id: "x" }), undefined);
    assert.equal(priceOf({ id: "x", pricing: { prompt: "free" } }), undefined);
    assert.equal(priceOf(null), undefined);
  });

  it("keeps a zero, which is a real answer, and drops a negative, which is not", () => {
    assert.deepEqual(priceOf({ id: "x", pricing: { prompt: "0", completion: "0" } }), {
      input: 0,
      output: 0,
    });
    assert.equal(priceOf({ id: "x", pricing: { prompt: "-1", completion: "1" } }), undefined);
  });

  it("collects only the priced models from a listing", () => {
    const prices = pricesFrom([
      { id: "cheap", pricing: { prompt: "0.0000001", completion: "0.0000002" } },
      { id: "silent" },
    ]);
    assert.deepEqual(Object.keys(prices), ["cheap"]);
  });
});

describe("saying it out loud", () => {
  it("keeps small prices legible instead of rounding them to zero", () => {
    assert.equal(money(0), "$0");
    assert.equal(money(0.002), "$0.0020");
    assert.equal(money(0.15), "$0.15");
    assert.equal(money(3), "$3");
    assert.equal(money(15.5), "$15.50");
  });

  it("says free only when both halves are free", () => {
    assert.equal(priceLabel({ input: 0, output: 0 }), "free");
    assert.equal(priceLabel({ input: 0, output: 2 }), "$0 / $2");
    assert.equal(priceLabel(undefined), "");
  });

  it("says where the number came from, because it is not MyRA's", () => {
    assert.match(priceTitle({ input: 3, output: 15 }), /as this provider reported it/);
    assert.match(priceTitle({ input: 3, output: 15 }), /no price list of its own/);
    assert.equal(priceTitle(undefined), "");
  });
});

describe("what survives a round trip through settings", () => {
  it("keeps well-formed pairs and drops everything else", () => {
    const prices = parsePrices({
      good: { input: 3, output: 15 },
      half: { input: 3 },
      junk: "cheap",
      negative: { input: -1, output: 1 },
    });
    assert.deepEqual(Object.keys(prices), ["good"]);
  });
});
