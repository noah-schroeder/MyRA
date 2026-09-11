/**
 * The llama.cpp flags, over the one free-text string that carries them.
 *
 * The property that matters most is not which flags are offered: it is that a
 * string this panel has rewritten still contains everything it did before.
 * Lemonade's own default for a llamacpp model is `--parallel 1`, so a panel that
 * dropped what it did not recognise would change how the server launches the
 * first time anybody opened it.
 *
 * The second property is that the checking happens here at all. Measured against
 * lemond 11.8.0: `llamacpp_args: "--parallel 1 --myra-nonsense 3"` is accepted
 * with a 200 and fails later, at load, inside a process nobody is watching.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  kvBytesPerElement, LLAMA_FLAGS, readFlags, tokenize, validFlag, writeFlags,
} from "../src/core/runtime/llamaArgs.ts";

const spec = (flag: string) => LLAMA_FLAGS.find((f) => f.flag === flag)!;

test("reads the flags it knows, under one spelling", () => {
  const { values } = readFlags("-ngl 48 --mlock --cache-type-k q8_0 --parallel 1");
  assert.deepEqual(values, {
    "--n-gpu-layers": "48",
    "--mlock": "true",
    "--cache-type-k": "q8_0",
    "--parallel": "1",
  });
});

test("keeps every token it does not own", () => {
  const { unknown } = readFlags("--parallel 1 --myra-nonsense 3 --verbose");
  assert.deepEqual(unknown, ["--myra-nonsense", "3", "--verbose"]);
});

test("the daemon's own default survives a round trip untouched", () => {
  const before = "--parallel 1";
  const { values } = readFlags(before);
  assert.equal(writeFlags(before, values), before);
});

test("an unrecognised flag survives being rewritten around", () => {
  const before = "--myra-nonsense 3 --parallel 1 --verbose";
  const after = writeFlags(before, { ...readFlags(before).values, "--threads": "8" });
  for (const token of ["--myra-nonsense", "3", "--verbose"]) {
    assert.ok(after.includes(token), `${token} was dropped from ${after}`);
  }
  assert.ok(after.includes("--threads 8"));
});

test("clearing a flag takes its value with it", () => {
  const before = "--threads 8 --parallel 1";
  const after = writeFlags(before, { "--parallel": "1" });
  /* The bug this pins: stepping over the flag but not its value leaves a bare
     `8` in the argument string, which llama-server reads as a positional. */
  assert.equal(after, "--parallel 1");
});

test("a flag written with an alias settles into the canonical spelling", () => {
  const before = "-ngl 48";
  assert.equal(writeFlags(before, readFlags(before).values), "--n-gpu-layers 48");
});

test("a toggle is present or absent, never `--mlock false`", () => {
  assert.equal(writeFlags("", { "--mlock": "true" }), "--mlock");
  assert.equal(writeFlags("--mlock", {}), "");
});

test("a value cannot smuggle in a second flag", () => {
  /* The registry's rule is about model-chosen strings and these are the user's,
     but the narrowing is enforced anyway: nothing typed into a number or an
     enum may contain whitespace. */
  assert.match(validFlag(spec("--threads"), "8 --myra-nonsense 3")!, /cannot contain spaces/);
  assert.match(validFlag(spec("--cache-type-k"), "q8_0 --mlock")!, /cannot contain spaces/);
});

test("free text is quoted rather than refused, because a split needs a comma", () => {
  assert.equal(validFlag(spec("--tensor-split"), "3, 1"), undefined);
  assert.equal(writeFlags("", { "--tensor-split": "3, 1" }), '--tensor-split "3, 1"');
  /* And it comes back as one token rather than two. */
  assert.deepEqual(readFlags('--tensor-split "3, 1"').values, { "--tensor-split": "3, 1" });
});

test("refuses a value the field cannot hold", () => {
  assert.match(validFlag(spec("--cache-type-k"), "q3_k")!, /must be one of/);
  assert.match(validFlag(spec("--threads"), "half")!, /must be a number/);
  assert.match(validFlag(spec("--threads"), "1.5")!, /whole number/);
  assert.match(validFlag(spec("--threads"), "0")!, /at least 1/);
  assert.equal(validFlag(spec("--threads"), "8"), undefined);
});

test("a flag with no value is not allowed to eat the next one", () => {
  const { values, unknown } = readFlags("--threads --mlock");
  assert.equal(values["--mlock"], "true");
  assert.equal(values["--threads"], undefined);
  assert.deepEqual(unknown, ["--threads"]);
});

test("flash attention takes a value now, not a bare flag", () => {
  /* Measured against the bundled binary: `llama-server --flash-attn` alone
     refuses to start with "expected value for argument". */
  assert.deepEqual(readFlags("--flash-attn on").values, { "--flash-attn": "on" });
  assert.equal(writeFlags("", { "--flash-attn": "auto" }), "--flash-attn auto");
});

test("an old bare --flash-attn heals itself on the next rewrite", () => {
  /* The shape the toggle-kind UI used to write, before this flag turned out to
     require a value. Read back, it has no value to attach to it, so it is
     unknown -- and the next time anything in the panel is edited, it is not
     carried forward, because the values object rebuilding the string never had
     an entry for it either. Neither state stops the model loading: it goes
     back to being genuinely unset, which is what the daemon already defaults
     to as `auto`. */
  const before = "--flash-attn --parallel 1";
  const { values, unknown } = readFlags(before);
  assert.equal(values["--flash-attn"], undefined);
  assert.ok(unknown.includes("--flash-attn"));
  const after = writeFlags(before, { ...values, "--threads": "8" });
  assert.ok(!after.includes("--flash-attn"), `${after} still carries the broken flag`);
  assert.ok(after.includes("--parallel 1"));
});

test("tokenising keeps a quoted run together and drops the quotes", () => {
  assert.deepEqual(tokenize('--a "one two"  --b three'), ["--a", "one two", "--b", "three"]);
  assert.deepEqual(tokenize("   "), []);
});

test("the two flags that interact with the rest of the app say so", () => {
  /* --parallel divides the window per slot, which parseProps reads and
     fitsContext believes; --cache-type-k changes the bytes the sizer counts. */
  assert.ok(spec("--parallel").warn);
  assert.ok(spec("--cache-type-k").warn);
});

test("a quantised key cache is reported as what it costs the sizer", () => {
  assert.equal(kvBytesPerElement("--cache-type-k q8_0"), 1);
  assert.equal(kvBytesPerElement("--cache-type-k q4_0 --flash-attn"), 0.5);
  assert.equal(kvBytesPerElement("--cache-type-k f16"), 2);
  /* Nothing set means "ask fit.ts for its own default", not "assume f16 here"
     -- one default, in one place. */
  assert.equal(kvBytesPerElement("--parallel 1"), undefined);
  assert.equal(kvBytesPerElement("--cache-type-k iq4_nl"), undefined);
});
