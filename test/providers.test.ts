/**
 * Where a conversation goes.
 *
 * The asymmetry is the whole point: a wrong "external" costs a warning nobody
 * needed, and a wrong "local" tells a researcher their transcripts stayed on
 * their laptop while they were being posted somewhere else. These tests are
 * about which of those two mistakes the code is allowed to make.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  choiceIsExternal, effectiveKind, isExternal, kindWasOverridden, newProviderId,
  parseModelRef, parseProviders, providerFor, providerSecret, qualify, urlIsLocal,
  type Provider,
} from "../src/core/providers.ts";

const provider = (over: Partial<Provider> = {}): Provider => ({
  id: "p1", label: "Test", kind: "local", baseUrl: "http://127.0.0.1:8080/v1",
  models: [], enabled: true, ...over,
});

test("loopback is local, including the rest of 127/8", () => {
  // llama.cpp servers are routinely bound to 127.0.0.2 and up to keep several
  // of them apart, and those are no less on this machine than 127.0.0.1.
  for (const url of [
    "http://127.0.0.1:8080/v1", "http://127.0.0.7:1234", "http://localhost:11434/v1",
    "http://[::1]:8080/v1",
  ]) {
    assert.equal(urlIsLocal(url), true, url);
  }
});

test("a LAN box is not local, because the data left this machine", () => {
  /* Splitting that hair only matters to whoever set the network up. The warning
     the user asked for -- "data will be sent to an external system" -- is true
     of a server down the corridor. */
  for (const url of [
    "http://192.168.1.50:8080/v1", "http://10.0.0.4:8080", "https://api.openai.com/v1",
    "http://gpu-box.local:8080/v1",
  ]) {
    assert.equal(urlIsLocal(url), false, url);
  }
});

test("an unparseable endpoint is treated as leaving the machine", () => {
  // Unknowable, so assumed to be the worse of the two. Never the other way.
  assert.equal(urlIsLocal("not a url"), false);
  assert.equal(urlIsLocal(""), false);
});

test("calling a remote endpoint local does not make it local", () => {
  /* The label can only make Karen more cautious. This is the assertion that
     stops a mislabelled provider putting a false "stays on your machine" in
     front of the one decision where it matters. */
  const mislabelled = provider({ kind: "local", baseUrl: "https://api.openai.com/v1" });
  assert.equal(effectiveKind(mislabelled), "external");
  assert.equal(isExternal(mislabelled), true);
  assert.equal(kindWasOverridden(mislabelled), true, "and the user is told, not silently corrected");
});

test("calling a loopback endpoint external is honoured", () => {
  // Over-caution is the user's to choose; under-caution is not.
  const cautious = provider({ kind: "external", baseUrl: "http://127.0.0.1:8080/v1" });
  assert.equal(effectiveKind(cautious), "external");
  assert.equal(kindWasOverridden(cautious), false, "nothing was overridden — they asked for this");
});

test("a model choice is qualified by its provider, and a bare name still works", () => {
  /* Every model chosen before providers existed is a bare name, so this is the
     migration too: nothing stored needs rewriting. */
  assert.deepEqual(parseModelRef("Qwen3-4B-GGUF"), { providerId: "", model: "Qwen3-4B-GGUF" });
  assert.deepEqual(parseModelRef(qualify("p2", "gpt-4o")), { providerId: "p2", model: "gpt-4o" });
});

test("a model id containing a colon survives qualification", () => {
  // "qwen2.5:7b" is an ordinary model name. A single-colon separator would cut
  // it in half and route to a provider called "qwen2.5".
  assert.deepEqual(parseModelRef("p3::qwen2.5:7b"), { providerId: "p3", model: "qwen2.5:7b" });
  assert.deepEqual(parseModelRef("qwen2.5:7b"), { providerId: "", model: "qwen2.5:7b" });
});

test("a bare model is not external; a model whose provider is gone is", () => {
  /* A provider deleted since the choice was made leaves a model Karen cannot
     account for. The honest answer is that it does not know where that goes,
     and not knowing is treated as leaving. */
  const providers = [provider({ id: "p1", kind: "local" })];
  assert.equal(choiceIsExternal(providers, "Qwen3-4B-GGUF"), false);
  assert.equal(choiceIsExternal(providers, "p1::local-model"), false);
  assert.equal(choiceIsExternal(providers, "vanished::gpt-4o"), true);
  assert.equal(providerFor(providers, "vanished::gpt-4o"), undefined);
});

test("a stored provider is rebuilt field by field, not spread", () => {
  const parsed = parseProviders([
    { id: "p1", label: "OpenAI", kind: "external", baseUrl: "https://api.openai.com/v1",
      models: ["gpt-4o", "gpt-4o", "gpt-4o-mini"], enabled: true, sneaky: "ignored" },
    { id: "p2", baseUrl: "http://127.0.0.1:9/v1" },
    { label: "no id", baseUrl: "http://127.0.0.1:9/v1" },
    { id: "p3" },
    "nonsense",
  ]);
  assert.deepEqual(parsed.map((p) => p.id), ["p1", "p2"]);
  assert.deepEqual(parsed[0]!.models, ["gpt-4o", "gpt-4o-mini"], "duplicates collapse");
  assert.equal("sneaky" in parsed[0]!, false);
  assert.equal(parsed[1]!.label, "http://127.0.0.1:9/v1", "an unnamed provider is named by its URL");
});

test("a missing or corrupt kind reads as external", () => {
  const [p] = parseProviders([{ id: "p1", baseUrl: "http://127.0.0.1:8080/v1", kind: "banana" }]);
  assert.equal(p!.kind, "external", "fails to the cautious side, not the convenient one");
});

test("a duplicate id is dropped rather than making routing depend on order", () => {
  const parsed = parseProviders([
    { id: "p1", label: "First", baseUrl: "http://127.0.0.1:1/v1" },
    { id: "p1", label: "Second", baseUrl: "https://elsewhere.example/v1" },
  ]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.label, "First");
});

test("ids are unique and do not move when a label changes", () => {
  const existing = [provider({ id: "p1" }), provider({ id: "p2" })];
  assert.equal(newProviderId(existing), "p3");
  assert.equal(newProviderId([]), "p1");
  assert.equal(providerSecret("p3"), "provider:p3");
});
