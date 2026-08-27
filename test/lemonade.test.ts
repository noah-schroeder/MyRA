/**
 * Starting the Lemonade daemon.
 *
 * The two arguments that matter here were established by measurement, not by
 * reading documentation, and both are easy to lose in a refactor -- so they are
 * pinned by tests that say why.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  apiBase, embeddableAsset, embeddableUrl, LEMONADE_VERSION, lemondArgs, lemondName,
  mergeConfig, openAiBase, parseHealth, pinnedConfig,
} from "../src/core/runtime/lemonade.ts";

describe("embeddableAsset", () => {
  it("names the build upstream actually publishes for each platform", () => {
    assert.equal(embeddableAsset("linux", "x64"), `lemonade-embeddable-${LEMONADE_VERSION}-ubuntu-x64.tar.gz`);
    assert.equal(embeddableAsset("linux", "arm64"), `lemonade-embeddable-${LEMONADE_VERSION}-ubuntu-arm64.tar.gz`);
    assert.equal(embeddableAsset("darwin", "arm64"), `lemonade-embeddable-${LEMONADE_VERSION}-macos-arm64.tar.gz`);
    assert.equal(embeddableAsset("win32", "x64"), `lemonade-embeddable-${LEMONADE_VERSION}-windows-x64.zip`);
  });

  it("says nothing rather than composing a URL that will 404", () => {
    /* There is no macOS x64 build and no Windows arm64 one. Guessing here would
       move the failure from install time to download time, where it reads as a
       network fault rather than an unsupported machine. */
    assert.equal(embeddableAsset("darwin", "x64"), undefined);
    assert.equal(embeddableAsset("win32", "arm64"), undefined);
    assert.equal(embeddableAsset("linux", "riscv64"), undefined);
  });

  it("points at the pinned release, not at latest", () => {
    const url = embeddableUrl(embeddableAsset("linux", "x64")!);
    assert.match(url, /lemonade-sdk\/lemonade\/releases\/download\/v11\.8\.0\//);
    assert.doesNotMatch(url, /latest/);
  });

  it("knows the daemon is an .exe on Windows only", () => {
    assert.equal(lemondName("linux"), "lemond");
    assert.equal(lemondName("darwin"), "lemond");
    assert.equal(lemondName("win32"), "lemond.exe");
  });
});

describe("lemondArgs", () => {
  const args = lemondArgs({ port: 13305, cacheDir: "/c", configDir: "/g" });

  it("disables UDP broadcast, which is on by default", () => {
    /* lemond advertises itself over UDP for server discovery unless told not
       to. A private assistant announcing itself to the local network is a
       privacy fault, so this flag is a requirement rather than a preference. */
    assert.ok(args.includes("--no-broadcast"));
  });

  it("binds loopback and nothing else", () => {
    assert.equal(args[args.indexOf("--host") + 1], "127.0.0.1");
    assert.ok(!args.includes("0.0.0.0"));
  });

  it("passes both state directories, so nothing lands outside Karen's own", () => {
    /* cache_dir and config_dir are positional and come last; without them the
       daemon writes to ~/.cache/lemonade and ~/.config/lemonade, which a Karen
       uninstall would then leave behind. */
    assert.deepEqual(args.slice(-2), ["/c", "/g"]);
  });

  it("carries the port it was given", () => {
    assert.equal(args[args.indexOf("--port") + 1], "13305");
  });
});

describe("base urls", () => {
  it("separates the OpenAI alias from the management API", () => {
    // Both were measured answering 200; they are used for different things.
    assert.equal(openAiBase(1234), "http://127.0.0.1:1234/v1");
    assert.equal(apiBase(1234), "http://127.0.0.1:1234/api/v1");
  });

  it("never addresses the daemon by anything but loopback", () => {
    assert.match(openAiBase(1), /^http:\/\/127\.0\.0\.1:/);
    assert.match(apiBase(1), /^http:\/\/127\.0\.0\.1:/);
  });
});

describe("parseHealth", () => {
  it("reads the payload the daemon actually returns", () => {
    const health = parseHealth({
      all_models_loaded: ["a", "b"], model_loaded: "a", max_models: { llm: 1 },
    });
    assert.deepEqual(health.loaded, ["a", "b"]);
    assert.equal(health.modelLoaded, "a");
  });

  it("does not throw on a shape that is not ours to control", () => {
    /* Readiness is "it answered 200"; these fields are decoration. A parser
       that threw on an unexpected key would turn a cosmetic upstream change
       into a daemon that never starts. */
    assert.deepEqual(parseHealth({}).loaded, []);
    assert.deepEqual(parseHealth(null).loaded, []);
    assert.deepEqual(parseHealth({ all_models_loaded: "nonsense" }).loaded, []);
    assert.equal(parseHealth({ model_loaded: "" }).modelLoaded, undefined);
  });
});

describe("pinnedConfig", () => {
  it("turns off the two defaults that reach the network on their own", () => {
    /* Both read off the daemon's own defaults.json: broadcast=true advertises
       the server over UDP, and auto_check_model_updates=true contacts Hugging
       Face on a timer. Neither is something a private assistant should do
       without being asked. */
    const c = pinnedConfig();
    assert.equal(c["broadcast"], false);
    assert.equal(c["auto_check_model_updates"], false);
    assert.equal(c["auto_update_models"], false);
  });

  it("pins telemetry off rather than trusting the default", () => {
    // It already defaults to false. A guarantee resting on someone else's
    // default is not a guarantee.
    assert.deepEqual(pinnedConfig()["telemetry"], { enabled: false });
  });
});

describe("mergeConfig", () => {
  it("keeps settings Karen does not care about", () => {
    const out = mergeConfig({ ctx_size: 8192, models_dir: "/models" });
    assert.equal(out["ctx_size"], 8192);
    assert.equal(out["models_dir"], "/models");
  });

  it("overrides a user or daemon value that would re-enable the network", () => {
    const out = mergeConfig({ broadcast: true, auto_check_model_updates: true });
    assert.equal(out["broadcast"], false);
    assert.equal(out["auto_check_model_updates"], false);
  });

  it("does not discard the rest of the telemetry block while disabling it", () => {
    /* A shallow merge would drop hide_inputs and the otlp settings, which are
       the controls someone would have set deliberately. */
    const out = mergeConfig({
      telemetry: { enabled: true, hide_inputs: true, otlp: { endpoint: "http://localhost:4318" } },
    });
    const t = out["telemetry"] as Record<string, unknown>;
    assert.equal(t["enabled"], false);
    assert.equal(t["hide_inputs"], true);
    assert.deepEqual(t["otlp"], { endpoint: "http://localhost:4318" });
  });
});
