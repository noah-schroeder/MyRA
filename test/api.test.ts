/**
 * The gateway's core: keys, the allowlist, config, and the log.
 *
 * The allowlist tests are the important ones. Lemonade's own key has no
 * scopes -- measured, it will install backends and delete models for anyone
 * holding it -- so the list of paths Karen forwards is the entire security
 * boundary of this feature.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  API_DEFAULTS, baseUrl, mergeApiConfig, refuseReason, validPort,
} from "../src/core/api/config.ts";
import {
  RequestLog, modelFrom, tokensPerSecond, usageFrom,
} from "../src/core/api/log.ts";
import {
  KEY_PREFIX, bearerFrom, displayKey, findKey, hashKey, mintKey,
} from "../src/core/api/keys.ts";
import { NEVER_EXPOSED, ROUTES, normalisePath, routeFor } from "../src/core/api/routes.ts";

/* --------------------------------------------------------------- allowlist -- */

test("no destructive Lemonade route is exposed", () => {
  for (const path of NEVER_EXPOSED) {
    for (const method of ["GET", "POST"]) {
      assert.equal(routeFor(method, path), undefined, `${method} ${path} must not be routable`);
    }
  }
});

test("the route table itself contains none of the forbidden paths", () => {
  /* Redundant with the test above and deliberately so: that one checks the
     lookup, this one checks the data, and a mistake could be in either. */
  for (const route of ROUTES) {
    assert.ok(!NEVER_EXPOSED.includes(route.path), `${route.path} is in ROUTES and must not be`);
  }
});

test("installing a backend is not reachable, which is the point of the gateway", () => {
  assert.equal(routeFor("POST", "/api/v1/install"), undefined);
  assert.equal(routeFor("POST", "/api/v1/install?x=1"), undefined);
  assert.equal(routeFor("POST", "/api/v1/install/"), undefined);
});

test("an unknown path is denied rather than forwarded", () => {
  assert.equal(routeFor("GET", "/v1/anything"), undefined);
  assert.equal(routeFor("POST", "/"), undefined);
  assert.equal(routeFor("POST", "/api/v2/chat/completions"), undefined);
});

test("matching is exact, so a prefix cannot smuggle a path through", () => {
  assert.ok(routeFor("GET", "/v1/models"));
  // Lemonade really serves /api/v1/models/(.+), including DELETE.
  assert.equal(routeFor("GET", "/v1/models/something"), undefined);
  assert.equal(routeFor("POST", "/v1/chat/completions/../../api/v1/install"), undefined);
});

test("the method is part of the match", () => {
  assert.ok(routeFor("POST", "/v1/chat/completions"));
  assert.equal(routeFor("GET", "/v1/chat/completions"), undefined);
  assert.equal(routeFor("DELETE", "/v1/models"), undefined);
});

test("a query string and a trailing slash do not change the path", () => {
  assert.equal(normalisePath("/v1/models?limit=5"), "/v1/models");
  assert.equal(normalisePath("/v1/models/"), "/v1/models");
  assert.equal(normalisePath(""), "/");
});

test("only health is reachable without a key", () => {
  const open = ROUTES.filter((r) => r.open).map((r) => r.path);
  assert.deepEqual(open, ["/health"]);
});

test("all three dialects a client might speak are served", () => {
  const byDialect = new Set(ROUTES.map((r) => r.dialect));
  for (const d of ["openai", "ollama", "anthropic"]) assert.ok(byDialect.has(d as never), d);
});

/* -------------------------------------------------------------------- keys -- */

test("a minted key is shown once and stored only as a hash", () => {
  const { key, secret } = mintKey("Obsidian");
  assert.ok(secret.startsWith(KEY_PREFIX));
  assert.equal(key.hash, hashKey(secret));
  // The record must not carry the secret anywhere.
  assert.ok(!JSON.stringify(key).includes(secret.slice(KEY_PREFIX.length)));
});

test("two keys are never the same", () => {
  const seen = new Set(Array.from({ length: 50 }, () => mintKey("k").secret));
  assert.equal(seen.size, 50);
});

test("a key is found by its secret and nothing else matches", () => {
  const a = mintKey("a");
  const b = mintKey("b");
  const keys = [a.key, b.key];
  assert.equal(findKey(keys, a.secret)?.id, a.key.id);
  assert.equal(findKey(keys, b.secret)?.id, b.key.id);
  assert.equal(findKey(keys, `${a.secret}x`), undefined);
  assert.equal(findKey(keys, ""), undefined);
});

test("a revoked key stops working", () => {
  const a = mintKey("a");
  const b = mintKey("b");
  assert.equal(findKey([b.key], a.secret), undefined);
});

test("the display form cannot be used as a key", () => {
  const { key } = mintKey("x");
  const shown = displayKey(key);
  assert.ok(shown.includes("…"));
  assert.equal(findKey([key], shown), undefined);
});

test("all three header spellings carry a key", () => {
  assert.equal(bearerFrom({ authorization: "Bearer sk-karen-abc" }), "sk-karen-abc");
  assert.equal(bearerFrom({ authorization: "bearer sk-karen-abc" }), "sk-karen-abc");
  assert.equal(bearerFrom({ "x-api-key": "sk-karen-abc" }), "sk-karen-abc");
  assert.equal(bearerFrom({ "api-key": "sk-karen-abc" }), "sk-karen-abc");
  assert.equal(bearerFrom({}), "");
});

/* ------------------------------------------------------------------ config -- */

test("a config file cannot turn the server on by being malformed", () => {
  assert.equal(mergeApiConfig(null).enabled, false);
  assert.equal(mergeApiConfig("nonsense").enabled, false);
  assert.equal(mergeApiConfig({ enabled: "yes" }).enabled, false);
  assert.equal(mergeApiConfig({ lan: 1 }).lan, false);
});

test("a nonsense port falls back to the default rather than being used", () => {
  assert.equal(mergeApiConfig({ port: 80 }).port, API_DEFAULTS.port);
  assert.equal(mergeApiConfig({ port: -1 }).port, API_DEFAULTS.port);
  assert.equal(mergeApiConfig({ port: 1.5 }).port, API_DEFAULTS.port);
  assert.equal(mergeApiConfig({ port: 8080 }).port, 8080);
  assert.ok(!validPort(443));
});

test("a malformed key in the file is dropped, not loaded", () => {
  const good = mintKey("good").key;
  const merged = mergeApiConfig({ keys: [good, { id: "x" }, null, "nope"] });
  assert.equal(merged.keys.length, 1);
  assert.equal(merged.keys[0]?.id, good.id);
});

test("the server refuses to start without a key", () => {
  assert.match(refuseReason({ ...API_DEFAULTS, keys: [] }) ?? "", /key/i);
  assert.equal(refuseReason({ ...API_DEFAULTS, keys: [mintKey("k").key] }), undefined);
});

test("the address is the one a person will paste", () => {
  assert.equal(baseUrl({ ...API_DEFAULTS, port: 1234 }), "http://127.0.0.1:1234");
  assert.equal(baseUrl({ ...API_DEFAULTS, port: 9000 }, "192.168.1.5"), "http://192.168.1.5:9000");
});

/* --------------------------------------------------------------------- log -- */

const rec = (id: string, state: "open" | "done" = "done") => ({
  id, startedAt: new Date().toISOString(), keyLabel: "k", keyId: "1",
  method: "POST", path: "/v1/chat/completions", dialect: "openai", state,
});

test("the log is bounded, so a client in a retry loop cannot grow it forever", () => {
  const log = new RequestLog();
  for (let i = 0; i < 700; i++) log.start(rec(`r${i}`));
  assert.equal(log.entries.length, 500);
  // Newest first.
  assert.equal(log.entries[0]?.id, "r699");
});

test("clearing keeps requests that are still running", () => {
  const log = new RequestLog();
  log.start(rec("done1"));
  log.start(rec("live", "open"));
  log.clear();
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0]?.id, "live");
});

test("updating a record that has fallen off the ring does not throw", () => {
  const log = new RequestLog();
  log.start(rec("a"));
  assert.doesNotThrow(() => log.update("gone", { state: "done" }));
});

test("the model is read from whichever dialect asked", () => {
  assert.equal(modelFrom('{"model":"qwen3"}'), "qwen3");
  assert.equal(modelFrom("not json"), undefined);
  assert.equal(modelFrom(undefined), undefined);
});

test("token counts are read in all three dialects' spellings", () => {
  // OpenAI
  assert.deepEqual(usageFrom('{"usage":{"prompt_tokens":10,"completion_tokens":5}}'), { prompt: 10, completion: 5 });
  // Anthropic
  assert.deepEqual(usageFrom('{"usage":{"input_tokens":7,"output_tokens":3}}'), { prompt: 7, completion: 3 });
  // Ollama, which puts them at the top level under different names again
  assert.deepEqual(usageFrom('{"prompt_eval_count":12,"eval_count":9,"done":true}'), { prompt: 12, completion: 9 });
  assert.deepEqual(usageFrom("garbage"), {});
});

test("tokens per second measures generation, not time spent reading the prompt", () => {
  const speed = tokensPerSecond({
    ...rec("a"), completionTokens: 100, durationMs: 3000, firstTokenMs: 1000,
  });
  // 100 tokens in the 2s after the first token, not across all 3s.
  assert.equal(speed, 50);
});

test("there is no way to record a prompt, by construction", () => {
  /* Body logging was removed rather than shipped switched off. This asserts
     the absence: a record has nowhere to put a prompt, and the config has no
     switch that would ask for one. */
  const record = { ...rec("a") } as Record<string, unknown>;
  assert.ok(!("body" in record));
  assert.ok(!("logBodies" in mergeApiConfig({ logBodies: true })));
});

test("the default port avoids the tools this app sits beside", () => {
  // 1234 is LM Studio's and 11434 is Ollama's; claiming either breaks them.
  assert.notEqual(API_DEFAULTS.port, 1234);
  assert.notEqual(API_DEFAULTS.port, 11434);
  assert.ok(validPort(API_DEFAULTS.port));
});

test("load-on-demand is on, and is a switch rather than a constant", () => {
  assert.equal(API_DEFAULTS.loadOnDemand, true);
  assert.equal(mergeApiConfig({ loadOnDemand: false }).loadOnDemand, false);
});
