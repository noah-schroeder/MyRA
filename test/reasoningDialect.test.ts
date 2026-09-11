/**
 * How each endpoint spells "think harder", and what Karen puts on the wire.
 *
 * The values here are the vendors' own. The tests that matter are the ones
 * about what is NOT sent: a value Karen invented is the unknown parameter that
 * turns a working chat into a 400, and this module's whole job is to make that
 * unexpressible.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  dialectById, dialectForHost, effectiveLevel, mergeReasoningFields, reasoningFields,
  templateDialect, THINKING_KWARGS,
} from "../src/core/llm/reasoningDialect.ts";
import {
  alwaysThinks, findTemplateSwitches, PROBE_MESSAGES,
} from "../src/core/llm/templateProbe.ts";

test("an unrecognised host gets no control at all", () => {
  // The safe direction, and the common one. A guess here costs somebody's
  // next chat, and offering nothing costs them a menu.
  assert.equal(dialectForHost("https://llm.example.edu/v1"), undefined);
  assert.equal(dialectForHost("http://127.0.0.1:8000/v1"), undefined);
  assert.equal(dialectForHost("not a url"), undefined);
});

test("each vendor keeps its own field name", () => {
  assert.equal(dialectForHost("https://api.openai.com/v1")?.param, "reasoning_effort");
  assert.equal(dialectForHost("https://openrouter.ai/api/v1")?.param, "reasoning");
  assert.equal(dialectForHost("https://api.anthropic.com/v1")?.param, "thinking");
  assert.equal(
    dialectForHost("https://generativelanguage.googleapis.com/v1beta/openai")?.param,
    "thinking_budget",
  );
});

test("a value the endpoint does not define is never sent", () => {
  const openai = dialectForHost("https://api.openai.com/v1");
  assert.ok(openai);
  assert.deepEqual(reasoningFields(openai, "extreme"), {});
  assert.deepEqual(reasoningFields(openai, ""), {});
  assert.deepEqual(reasoningFields(openai, "high"), { reasoning_effort: "high" });
});

test("OpenRouter's off is a switch, not an effort", () => {
  // Sending effort:"none" to a field documented as taking low/medium/high is
  // how a working chat becomes a 400.
  const or = dialectForHost("https://openrouter.ai/api/v1");
  assert.ok(or);
  assert.deepEqual(reasoningFields(or, "off"), { reasoning: { enabled: false } });
  assert.deepEqual(reasoningFields(or, "high"), { reasoning: { effort: "high" } });
});

test("Google's budget goes out as a number, nested where it belongs", () => {
  const g = dialectForHost("https://generativelanguage.googleapis.com/v1beta/openai");
  assert.ok(g);
  assert.deepEqual(reasoningFields(g, "0"), {
    google: { thinking_config: { thinking_budget: 0 } },
  });
  assert.deepEqual(reasoningFields(g, "-1"), {
    google: { thinking_config: { thinking_budget: -1 } },
  });
});

test("a template boolean goes out as a boolean", () => {
  // The bug this exists to prevent: a template testing `if enable_thinking`
  // treats the STRING "false" as true, so sending the choice verbatim turns
  // thinking off by turning it on.
  const t = templateDialect("enable_thinking");
  assert.ok(t);
  assert.deepEqual(reasoningFields(t, "false"), {
    chat_template_kwargs: { enable_thinking: false },
  });
  assert.deepEqual(reasoningFields(t, "true"), {
    chat_template_kwargs: { enable_thinking: true },
  });
});

test("only the switches that mean “should you think” are candidates", () => {
  // `preserve_thinking` changes LFM2.5's rendered prompt -- measured -- but
  // what it changes is whether EARLIER turns keep their thinking on replay.
  // A control built by diffing any variable would have offered it as a
  // thinking switch.
  const names = THINKING_KWARGS.map((k) => k.name);
  assert.deepEqual(names, ["enable_thinking", "reasoning_effort", "reasoning_strength"]);
  assert.equal(names.includes("preserve_thinking"), false);
  assert.equal(templateDialect("preserve_thinking"), undefined);
});

/* ------------------------------------------------------ template probe -- */

/** A stand-in llama-server: renders `on` only for the variables it knows. */
function server(reads: string[]): (b: Record<string, unknown>) => Promise<string | undefined> {
  return async (body) => {
    const kwargs = (body["chat_template_kwargs"] ?? {}) as Record<string, unknown>;
    const seen = Object.entries(kwargs).filter(([k]) => reads.includes(k));
    return seen.length ? `PROMPT+${JSON.stringify(seen)}` : "PROMPT";
  };
}

test("a template that reads the switch is found", async () => {
  const found = await findTemplateSwitches(server(["enable_thinking"]));
  assert.deepEqual(found.map((d) => d.param), ["enable_thinking"]);
  assert.equal(found[0]?.evidence, "measured");
});

test("a template that reads both switches gets both controls", async () => {
  // The bug: the probe stopped at the first match, so a model answering both
  // "should you think" and "how hard" offered only the on/off switch -- and
  // the effort control was hidden on exactly the models that have one.
  const found = await findTemplateSwitches(server(["enable_thinking", "reasoning_effort"]));
  assert.deepEqual(found.map((d) => d.param), ["enable_thinking", "reasoning_effort"]);
});

test("a template reading only the effort switch still gets it", async () => {
  const found = await findTemplateSwitches(server(["reasoning_effort"]));
  assert.deepEqual(found.map((d) => d.param), ["reasoning_effort"]);
});

test("a template that ignores every switch offers no control", async () => {
  // LFM2.5: kwargs reach the template, and none of these is one it reads.
  assert.deepEqual(await findTemplateSwitches(server(["preserve_thinking"])), []);
});

test("an endpoint that cannot be asked is unknown, not unsupported", async () => {
  assert.deepEqual(await findTemplateSwitches(async () => undefined), []);
});

/* ------------------------------------------------------- the default -- */

test("a model that can think is asked to, unless the user says otherwise", () => {
  // Sending nothing hands the decision to whatever that template happens to
  // default to, which differs between models spelling the switch identically.
  const think = templateDialect("enable_thinking");
  assert.ok(think);
  assert.equal(effectiveLevel(think, undefined), "true");
  assert.equal(effectiveLevel(think, "false"), "false");
});

test("nothing is sent by default where sending costs money", () => {
  // A hosted effort nobody asked for is billed to somebody's account, and on
  // a strict gateway it is the unknown field that fails the whole request.
  for (const url of [
    "https://api.openai.com/v1",
    "https://openrouter.ai/api/v1",
    "https://api.anthropic.com/v1",
    "https://generativelanguage.googleapis.com/v1beta/openai",
  ]) {
    const found = dialectForHost(url);
    assert.ok(found);
    assert.equal(effectiveLevel(found, undefined), "");
  }
  // Nor for the local effort switch: how hard is the template's call to make,
  // and Karen has no basis for overruling it.
  const effort = templateDialect("reasoning_effort");
  assert.ok(effort);
  assert.equal(effectiveLevel(effort, undefined), "");
});

test("a level left over from another dialect falls back, never through", () => {
  // A choice stored under one endpoint's vocabulary is not a level under
  // another's, whatever it reads as.
  const think = templateDialect("enable_thinking");
  assert.ok(think);
  assert.equal(effectiveLevel(think, "high"), "true");
  const openai = dialectForHost("https://api.openai.com/v1");
  assert.ok(openai);
  assert.equal(effectiveLevel(openai, "-1"), "");
});

test("two template switches both survive being merged", () => {
  // A plain spread loses one: each returns a chat_template_kwargs object, so
  // the second silently replaced the first and a model told how hard to think
  // stopped being told to think at all.
  const think = templateDialect("enable_thinking");
  const effort = templateDialect("reasoning_effort");
  assert.ok(think && effort);
  assert.deepEqual(
    mergeReasoningFields([reasoningFields(think, "true"), reasoningFields(effort, "high")]),
    { chat_template_kwargs: { enable_thinking: true, reasoning_effort: "high" } },
  );
  // And a merge of nothing stays nothing, so no field is sent at all.
  assert.deepEqual(mergeReasoningFields([{}, {}]), {});
});

test("the probe sends a prior assistant turn, so replay-only switches show up", () => {
  // Without one, a template whose only use of the variable is on earlier
  // messages renders identically and reads as no support.
  assert.equal(PROBE_MESSAGES.some((m) => m.role === "assistant"), true);
});

test("a prompt ending in an opened think block is a model that always thinks", () => {
  // Measured: every LFM2.5 render ends `<|im_start|>assistant\n<think>`.
  assert.equal(alwaysThinks("<|im_start|>assistant\n<think>"), true);
  assert.equal(alwaysThinks("<|im_start|>assistant\n"), false);
  assert.equal(alwaysThinks(undefined), false);
});

/* --------------------------------------------------- storing the choice -- */

test("a stored dialect id resolves back to the same dialect", () => {
  // The choice outlives the session that made it, and is turned into request
  // fields from the id alone. An id that no longer resolves must produce no
  // fields rather than a half-built one.
  for (const url of [
    "https://api.openai.com/v1",
    "https://openrouter.ai/api/v1",
    "https://api.anthropic.com/v1",
    "https://generativelanguage.googleapis.com/v1beta/openai",
  ]) {
    const found = dialectForHost(url);
    assert.ok(found);
    assert.equal(dialectById(found.id)?.param, found.param);
  }
  assert.equal(dialectById("template:enable_thinking")?.param, "enable_thinking");
  assert.equal(dialectById("something-removed"), undefined);
  assert.equal(dialectById("template:preserve_thinking"), undefined);
});

test("a subdomain of a known host still speaks that dialect", () => {
  assert.equal(
    dialectForHost("https://eu.generativelanguage.googleapis.com/v1beta/openai")?.param,
    "thinking_budget",
  );
  // But a host that merely ends in the same letters does not.
  assert.equal(dialectForHost("https://notopenrouter.ai/api/v1"), undefined);
});

/* ------------------------------------------------------- onto the wire -- */

test("the chosen level reaches the request body, and displaces nothing", async () => {
  // The gap this closes: everything above is about computing fields, and a
  // field computed correctly into a bag nobody spreads is still a control
  // that does nothing.
  const { buildRequest } = await import("../src/core/llm/chat.ts");
  const openai = dialectForHost("https://api.openai.com/v1");
  assert.ok(openai);

  const body = buildRequest({
    model: "gpt-5",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    extra: reasoningFields(openai, "high"),
  }) as Record<string, unknown>;

  assert.equal(body["reasoning_effort"], "high");
  // extras are spread FIRST, so none of these can be rewritten by one.
  assert.equal(body["model"], "gpt-5");
  assert.equal(body["stream"], true);
});

test("a template switch rides in chat_template_kwargs, not at the top level", async () => {
  // llama.cpp ignores unknown top-level fields silently, so a switch sent
  // there would look like it worked and change nothing.
  const { buildRequest } = await import("../src/core/llm/chat.ts");
  const local = templateDialect("enable_thinking");
  assert.ok(local);
  const body = buildRequest({
    messages: [{ role: "user", content: "hi" }],
    extra: reasoningFields(local, "false"),
  }) as Record<string, unknown>;

  assert.deepEqual(body["chat_template_kwargs"], { enable_thinking: false });
  assert.equal(body["enable_thinking"], undefined);
});

test("no choice means no field at all", () => {
  // The default has to be silence: every field here is one a strict endpoint
  // can refuse the whole request over.
  const openai = dialectForHost("https://api.openai.com/v1");
  assert.ok(openai);
  assert.deepEqual(reasoningFields(openai, ""), {});
});
