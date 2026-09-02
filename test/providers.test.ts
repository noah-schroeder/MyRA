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
  isUsable, orphanedSecrets, parseModelRef, parseProviders, providerFor, providerSecret,
  qualify, urlIsLocal,
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

test("a provider exists before it has an address", () => {
  /* "Add a provider" creates one with nothing but an id and then it is filled
     in. Requiring a base URL on the way into storage meant the save that
     follows the button discarded it, so the button did nothing at all. */
  const fresh = { id: "pnew", label: "", kind: "external", baseUrl: "", models: [], enabled: true };
  assert.deepEqual(parseProviders([fresh]), [fresh]);
  // It is still not something a request can be sent to, and that is separate.
  assert.equal(isUsable(fresh as Provider), false);
  assert.equal(isUsable({ ...fresh, baseUrl: "http://127.0.0.1:1/v1" } as Provider), true);
  assert.equal(isUsable({ ...fresh, baseUrl: "http://127.0.0.1:1/v1", enabled: false } as Provider), false);
});

test("a half-typed provider is not told its blank address is remote", () => {
  const typing = { id: "p1", label: "", kind: "local", baseUrl: "", models: [], enabled: true } as Provider;
  assert.equal(kindWasOverridden(typing), false);
  // But the moment there is an address to disagree with, it says so.
  assert.equal(kindWasOverridden({ ...typing, baseUrl: "https://elsewhere.example/v1" }), true);
});

test("an id with no base URL still survives, but a record with no id does not", () => {
  assert.deepEqual(parseProviders([{ baseUrl: "http://127.0.0.1:1/v1" }]), []);
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
  assert.deepEqual(parsed.map((p) => p.id), ["p1", "p2", "p3"]);
  assert.deepEqual(parsed[0]!.models, ["gpt-4o", "gpt-4o-mini"], "duplicates collapse");
  assert.equal("sneaky" in parsed[0]!, false);
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

test("a provider id is never handed out twice", () => {
  /* This is a credential rule, not a naming one. The key lives at
     `provider:<id>`, so a counter that reissued "p1" after the first provider
     was deleted would hand one vendor's API key to the next provider added --
     silently, because the field is write-only and shows nothing. */
  const seen = new Set<string>();
  let existing: Provider[] = [];
  for (let i = 0; i < 500; i++) {
    const id = newProviderId(existing);
    assert.equal(seen.has(id), false, `${id} was issued twice`);
    seen.add(id);
    existing = [...existing, provider({ id })];
  }
  // And deleting one does not free its id for the next provider.
  const after = existing.filter((p) => p.id !== existing[0]!.id);
  assert.equal(seen.has(newProviderId(after)), false);
});

test("a removed provider's key is named for deletion", () => {
  /* An API key that outlives the provider it belonged to is a credential still
     on disk that the person believes they deleted. */
  const before = [provider({ id: "pa" }), provider({ id: "pb" }), provider({ id: "pc" })];
  const after = [before[0]!, before[2]!];
  assert.deepEqual(orphanedSecrets(before, after), ["provider:pb"]);
  assert.deepEqual(orphanedSecrets(before, before), []);
  assert.deepEqual(orphanedSecrets(before, []).sort(),
    ["provider:pa", "provider:pb", "provider:pc"]);
  assert.equal(providerSecret("pb"), "provider:pb");
});

test("only a known secret name may be written to the vault", async () => {
  /* The type is a compile-time promise; this handler takes a name off the IPC
     wire, where `as SecretName` asserts rather than checks. */
  const { isSecretName } = await import("../src/core/secretNames.ts");
  for (const good of ["llmKey", "hfToken", "provider:pab12", "provider:p-1_2"]) {
    assert.equal(isSecretName(good), true, good);
  }
  for (const bad of ["", "provider:", "provider:../../etc", "provider:a b", "nonsense",
    "provider:" + "x".repeat(65)]) {
    assert.equal(isSecretName(bad), false, bad);
  }
});

test("deleting a secret does not depend on the keyring working", async () => {
  /* Found by review, and it is the worst shape of bug a credential store has:
     the removal branch sat after the usability check, so once the persistence
     probe decided the keyring would not persist -- which it can decide
     mid-session, when Settings is opened -- a delete cleared the in-memory copy
     and left the ciphertext on disk. `get()` reads through to disk, so the key
     the user had just removed went on being sent. Deleting is not encrypting
     and must not need a keyring. */
  const { vaultAction } = await import("../src/core/secretNames.ts");
  assert.equal(vaultAction("", true), "remove");
  assert.equal(vaultAction("", false), "remove", "a degraded keyring must still delete");
  assert.equal(vaultAction("sk-abc", true), "encrypt");
  assert.equal(vaultAction("sk-abc", false), "memory", "never written when it cannot be protected");
});

test("a choice whose provider is gone is broken, not quietly local", () => {
  /* It fell through to whatever model was loaded: answering from something the
     user did not choose, under a picker still showing the model they did, with
     the bar warning "external" about a request that never left the machine.
     The UI half of this is `choiceIsExternal` returning true for an
     unaccountable choice; the routing half must agree, and refuse. */
  const providers = [provider({ id: "alive" })];
  assert.equal(parseModelRef("gone::gpt-4o").providerId, "gone");
  assert.equal(providerFor(providers, "gone::gpt-4o"), undefined);
  assert.equal(choiceIsExternal(providers, "gone::gpt-4o"), true);
  // A bare name is not a dangling reference; it is the ordinary local case.
  assert.equal(parseModelRef("Qwen3-4B").providerId, "");
});

test("the privacy report gives the same answer as the rest of the app", async () => {
  /* One question -- does this leave the machine -- must have one answer. A
     loopback provider the user deliberately marked external is warned about at
     the picker and withheld the llama.cpp-only samplers; a report calling it
     "local" would be the app contradicting itself in the one document whose
     entire job is to be right about this. */
  const { configuredEndpoints, DEFAULT_SETTINGS } = await import("../src/core/config.ts");
  const rows = configuredEndpoints({
    ...DEFAULT_SETTINGS,
    providers: [
      provider({ id: "a", label: "Cautious", kind: "external", baseUrl: "http://127.0.0.1:9/v1" }),
      provider({ id: "b", label: "Genuinely local", kind: "local", baseUrl: "http://127.0.0.1:9/v1" }),
      provider({ id: "c", label: "Mislabelled", kind: "local", baseUrl: "https://elsewhere.example/v1" }),
      provider({ id: "d", label: "Off", kind: "external", baseUrl: "https://elsewhere.example/v1", enabled: false }),
      provider({ id: "e", label: "Half-typed", kind: "external", baseUrl: "" }),
    ],
  });
  assert.deepEqual(
    rows.filter((r) => r.label.startsWith("Models")).map((r) => [r.label, r.local]),
    [
      ["Models — Cautious", false],
      ["Models — Genuinely local", true],
      // The one that matters: a remote address never reads as local.
      ["Models — Mislabelled", false],
    ],
  );
});
