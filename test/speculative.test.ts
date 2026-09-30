/**
 * What the tuning panel offers for speculative decoding, and what it says.
 *
 * The decisions worth pinning are the ones whose mistake is invisible until a
 * model will not load: offering draft-mtp on a file with no MTP layers is a
 * launch failure ("context type MTP requested but model doesn't contain MTP
 * layers"), and hiding it on one that has them is a setting nobody finds.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { LLAMA_FLAGS, readFlags } from "../src/core/runtime/llamaArgs.ts";
import {
  draftMtpOn, gatedOut, mtpSupport, speculativeNote,
} from "../src/core/runtime/speculative.ts";

const spec = (flag: string) => LLAMA_FLAGS.find((f) => f.flag === flag)!;
const values = (args: string) => readFlags(args).values;

test("the file's own layers, or Lemonade's label, each say yes", () => {
  assert.equal(mtpSupport({ mtpLayers: 1 }), "yes");
  assert.equal(mtpSupport({ lemonadeMtp: true }), "yes");
});

test("a Gemma-4 MTP model has the label and no layers in its own weights, and is still yes", () => {
  /* Its head is a separate draft file, so the main GGUF names none. Reading
     only the header would call it `no` and hide the setting on exactly the
     models Lemonade switches MTP on for. */
  assert.equal(mtpSupport({ mtpLayers: 0, lemonadeMtp: true }), "yes");
});

test("a header that was read and names none is a finding; one never read is not", () => {
  assert.equal(mtpSupport({ mtpLayers: 0 }), "no");
  assert.equal(mtpSupport({}), "unknown");
});

test("only a model known to have MTP gets the controls in the default list", () => {
  for (const flag of ["--spec-type", "--spec-draft-n-max", "--spec-draft-n-min", "--spec-draft-p-min"]) {
    assert.equal(gatedOut(spec(flag), { mtpLayers: 1 }), false, flag);
    assert.equal(gatedOut(spec(flag), { mtpLayers: 0 }), true, flag);
    assert.equal(gatedOut(spec(flag), {}), true, flag);
  }
  /* A flag with no gate is never this function's business. */
  assert.equal(gatedOut(spec("--threads"), { mtpLayers: 0 }), false);
});

test("no --spec-type means Lemonade's default, which is on for an mtp-labelled model", () => {
  assert.equal(draftMtpOn(values("--parallel 1"), { lemonadeMtp: true }), true);
  assert.equal(draftMtpOn(values("--parallel 1"), { mtpLayers: 1 }), false);
});

test("any --spec-type replaces Lemonade's default, including none", () => {
  /* append_runtime_arg_defaults skips a default whose flag the user's own
     arguments carry, whatever the value. */
  assert.equal(draftMtpOn(values("--spec-type none"), { lemonadeMtp: true }), false);
  assert.equal(draftMtpOn(values("--spec-type draft-mtp"), {}), true);
});

test("a comma list is read as a list, not compared whole", () => {
  assert.equal(draftMtpOn(values("--spec-type ngram-mod,draft-mtp"), {}), true);
  assert.equal(draftMtpOn(values("--spec-type ngram-mod"), { lemonadeMtp: true }), false);
});

test("draft-mtp on a file with no MTP layers is called out as a launch failure", () => {
  const note = speculativeNote(spec("--spec-type"), values("--spec-type draft-mtp"), { mtpLayers: 0 });
  assert.equal(note?.bad, true);
  assert.match(note!.text, /no MTP layers/);
});

test("nothing is asserted about a model whose file was never read", () => {
  assert.equal(speculativeNote(spec("--spec-type"), values("--spec-type draft-mtp"), {}), undefined);
});

test("an mtp-labelled model is told its unset select means on", () => {
  const note = speculativeNote(spec("--spec-type"), values("--parallel 1"), { lemonadeMtp: true });
  assert.equal(note?.bad, false);
  assert.match(note!.text, /Lemonade already turns draft-mtp on/);
  /* ...and only while it is unset. */
  assert.equal(speculativeNote(spec("--spec-type"), values("--spec-type none"), { lemonadeMtp: true }), undefined);
});

test("a draft count set while drafting is off says it does nothing", () => {
  const n = spec("--spec-draft-n-max");
  assert.match(speculativeNote(n, values("--spec-draft-n-max 5"), { mtpLayers: 1 })!.text, /Does nothing/);
  assert.equal(speculativeNote(n, values("--spec-draft-n-max 5 --spec-type draft-mtp"), { mtpLayers: 1 }), undefined);
  assert.equal(speculativeNote(n, values("--parallel 1"), { lemonadeMtp: true }), undefined);
});

test("flags outside the gate get no note", () => {
  assert.equal(speculativeNote(spec("--threads"), values("--threads 8"), { mtpLayers: 0 }), undefined);
});
