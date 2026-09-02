/**
 * Sampler settings, and which of them a given endpoint is allowed to see.
 *
 * The filtering is the part with teeth. llama.cpp accepts top_k, min_p and DRY;
 * a hosted API answers 400 for the WHOLE request when it sees one, so a user
 * who tuned min-p for their local model would find every hosted model broken
 * with nothing on screen naming the cause.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  droppedForExternal, parseSampling, SAMPLING_FIELDS, samplingForRequest,
} from "../src/core/llm/sampling.ts";
import { buildRequest } from "../src/core/llm/chat.ts";

test("a hosted endpoint is sent only the fields it can accept", () => {
  const tuned = { temperature: 0.8, top_p: 0.9, top_k: 40, min_p: 0.05, repeat_penalty: 1.1 };
  assert.deepEqual(samplingForRequest(tuned, true), { temperature: 0.8, top_p: 0.9 });
  assert.deepEqual(samplingForRequest(tuned, false), tuned, "a local endpoint gets all of it");
  assert.deepEqual(droppedForExternal(tuned).sort(), ["Min-p", "Repetition penalty", "Top-k"]);
});

test("an out-of-range value is dropped, not clamped", () => {
  /* Clamping turns somebody's typo into a plausible number, and the replies go
     strange for a reason nothing on screen explains. */
  assert.deepEqual(parseSampling({ temperature: 40 }), {});
  assert.deepEqual(parseSampling({ temperature: -1 }), {});
  assert.deepEqual(parseSampling({ top_k: 12.5 }), {}, "an integer field refuses a fraction");
  assert.deepEqual(parseSampling({ temperature: 0.7 }), { temperature: 0.7 });
});

test("only known samplers survive a read", () => {
  // The stored file is editable by hand, and an unknown key sent to llama.cpp
  // is a 400 for the whole request.
  assert.deepEqual(parseSampling({ nonsense: 1, temperature: 0.5 }), { temperature: 0.5 });
  assert.deepEqual(parseSampling("not an object"), {});
  assert.deepEqual(parseSampling(null), {});
});

test("an unset field is absent from the request, not sent as zero", () => {
  /* Blank means "let the server decide", which is a different thing from Karen
     guessing the default and sending its guess. */
  const body = buildRequest({ messages: [], sampling: { top_k: 40 } });
  assert.equal("min_p" in body, false);
  assert.equal(body["top_k"], 40);
});

test("a tuned temperature is used, and a caller's still wins over it", () => {
  /* Screening and extraction pass their own temperature because they must not
     be creative. A per-model setting must not quietly warm those up. */
  assert.equal(buildRequest({ messages: [], sampling: { temperature: 0.9 } }).temperature, 0.9);
  assert.equal(
    buildRequest({ messages: [], temperature: 0.2, sampling: { temperature: 0.9 } }).temperature,
    0.2,
  );
  assert.equal(buildRequest({ messages: [] }).temperature, 0.2, "and the default still holds");
});

test("every field declares a usable range and says what it does", () => {
  for (const f of SAMPLING_FIELDS) {
    assert.ok(f.min < f.max, `${f.key} has an empty range`);
    assert.ok(f.help.length > 20, `${f.key} needs help text a person can act on`);
    assert.ok(f.step > 0, `${f.key} needs a step`);
  }
  // The ones a hosted API genuinely accepts, and no more.
  assert.deepEqual(
    SAMPLING_FIELDS.filter((f) => f.standard).map((f) => f.key).sort(),
    ["frequency_penalty", "max_tokens", "presence_penalty", "seed", "temperature", "top_p"],
  );
});
