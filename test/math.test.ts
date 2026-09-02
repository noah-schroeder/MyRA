/**
 * Which dollar signs are mathematics and which are money.
 *
 * The asymmetry matters: leaving maths unrendered shows the LaTeX, which is
 * ugly and readable. Rendering prose as maths mangles a sentence in a document
 * somebody is going to submit.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { hasMath, splitMath } from "../src/renderer/components/math.ts";

const maths = (text: string): string[] =>
  splitMath(text).filter((s) => s.kind === "math").map((s) => s.value);

describe("what counts as mathematics", () => {
  it("finds the statistics an academic paper is written in", () => {
    assert.deepEqual(maths("a small effect ($g^+ = 0.20$) overall"), ["g^+ = 0.20"]);
    assert.deepEqual(maths("retention ($r = .29$) and transfer ($r = .26$)"), ["r = .29", "r = .26"]);
    assert.deepEqual(maths("partial $\\eta^2$ was reported"), ["\\eta^2"]);
    assert.deepEqual(maths("with $p < .05$"), ["p < .05"]);
  });

  it("leaves money alone", () => {
    assert.deepEqual(maths("it costs $5 and $10 per month"), []);
    assert.deepEqual(maths("between $3.00 and $15.00 per million tokens"), []);
    assert.equal(hasMath("$5 and $10"), false);
  });

  it("takes a single symbol, which is how effect sizes are named", () => {
    assert.deepEqual(maths("the effect $d$ was small"), ["d"]);
    assert.deepEqual(maths("for $n$ participants"), ["n"]);
  });

  it("reads display maths as display", () => {
    const segments = splitMath("before $$x = \\frac{1}{2}$$ after");
    assert.equal(segments[1]!.kind, "math");
    assert.equal(segments[1]!.display, true);
    assert.deepEqual(maths("\\[ E = mc^2 \\]"), ["E = mc^2"]);
    assert.deepEqual(maths("inline \\(a^2\\) here"), ["a^2"]);
  });

  it("keeps the prose around it, in order", () => {
    const segments = splitMath("a $x^2$ b");
    assert.deepEqual(
      segments.map((s) => [s.kind, s.value]),
      [["text", "a "], ["math", "x^2"], ["text", " b"]],
    );
  });
});

describe("the ways a stray delimiter could ruin an answer", () => {
  it("does not pair a lone dollar with one paragraphs away", () => {
    const text = `a price of $20 for the first item\n\nand a second paragraph$`;
    assert.deepEqual(maths(text), []);
  });

  it("gives up on anything longer than an equation", () => {
    assert.deepEqual(maths(`$${"x=1 ".repeat(200)}$`), []);
  });

  it("treats an escaped dollar as a dollar", () => {
    const segments = splitMath("costs \\$5 today");
    assert.deepEqual(segments, [{ kind: "text", value: "costs $5 today" }]);
  });

  it("leaves an unclosed delimiter as text, which is what streaming looks like", () => {
    assert.deepEqual(maths("half an equation $x ="), []);
    assert.deepEqual(splitMath("half $x =").map((s) => s.value), ["half $x ="]);
  });
});
