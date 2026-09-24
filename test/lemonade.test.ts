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
  apiBase, EMBEDDABLE_SHA256, embeddableAsset, embeddableSha256, embeddableUrl, LEMONADE_VERSION,
  lemondArgs, lemondName,
  chatModelOf, chatModelToReload, isChatEngine, mergeConfig, openAiBase, parseHealth, pinnedConfig,
} from "../src/core/runtime/lemonade.ts";
import { executableName } from "../src/main/runtime/download.ts";

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

  it("passes both state directories, so nothing lands outside MyRA's own", () => {
    /* cache_dir and config_dir are positional and come last; without them the
       daemon writes to ~/.cache/lemonade and ~/.config/lemonade, which a MyRA
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
  it("keeps settings MyRA does not care about", () => {
    const out = mergeConfig({ ctx_size: 8192, models_dir: "/models" });
    assert.equal(out["ctx_size"], 8192);
    assert.equal(out["models_dir"], "/models");
  });

  it("overrides a user or daemon value that would re-enable the network", () => {
    const out = mergeConfig({ broadcast: true, auto_check_model_updates: true });
    assert.equal(out["broadcast"], false);
    assert.equal(out["auto_check_model_updates"], false);
  });

  it("lets the image engine fit itself to whatever VRAM is free", () => {
    /* Without it, stable-diffusion.cpp demands the diffusion model as one
       contiguous allocation and aborts: "allocating 1411.07 MiB on device 0:
       cudaMalloc failed: out of memory" on an 8 GB card already holding a chat
       model, a Whisper and a Kokoro. Lemonade will not free the card for it --
       max_loaded_models is 1 per TYPE, so it holds one of each and never
       evicts across pools. */
    assert.deepEqual(pinnedConfig()["sdcpp"], { args: "--auto-fit" });
  });

  it("keeps the engine's other settings while adding that one", () => {
    /* The block is merged, not replaced: `backend` and `steps` are the
       daemon's own and losing them would change how every image is made. */
    const merged = mergeConfig({ sdcpp: { backend: "cuda", steps: 20 } });
    assert.deepEqual(merged["sdcpp"], { backend: "cuda", steps: 20, args: "--auto-fit" });
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

describe("which loaded model a conversation goes to", () => {
  /* The exact payload a daemon holding all three sends, trimmed to the fields
     that matter. Measured, not invented: `type` is the daemon's own word for
     what each model is, and `model_loaded` names whichever was touched last --
     here Kokoro, because it spoke the previous answer. */
  const health = parseHealth({
    model_loaded: "kokoro-v1",
    all_models_loaded: [
      { model_name: "Whisper-Large-v3-Turbo", recipe: "whispercpp", type: "transcription", status: "ready" },
      { model_name: "kokoro-v1", recipe: "kokoro", type: "tts", status: "ready" },
      { model_name: "LFM2.5-2.6B-GGUF", recipe: "llamacpp", type: "llm", status: "ready" },
    ],
  });

  it("reads the daemon's own classification of each model", () => {
    assert.deepEqual(health.models.map((m) => m.type),
      ["transcription", "tts", "llm"]);
  });

  it("never hands a conversation to a speech model", () => {
    /* The report: Whisper and Kokoro appeared in the chat bar as the model in
       use, because dictating and speaking had each been the last thing to
       load. Neither can answer a message. */
    assert.equal(chatModelOf(health)?.id, "LFM2.5-2.6B-GGUF");
    assert.equal(chatModelOf(health, "Whisper-Large-v3-Turbo")?.id, "LFM2.5-2.6B-GGUF");
    assert.equal(chatModelOf(health, "kokoro-v1")?.id, "LFM2.5-2.6B-GGUF");
  });

  it("says nothing rather than naming a model that cannot answer", () => {
    const speechOnly = parseHealth({
      all_models_loaded: [
        { model_name: "Whisper-Tiny", recipe: "whispercpp", type: "transcription", status: "ready" },
      ],
    });
    // Which is what puts "None selected" in the bar instead of "Whisper-Tiny".
    assert.equal(chatModelOf(speechOnly), undefined);
  });

  it("keeps the user's choice when it is one that can answer", () => {
    assert.equal(chatModelOf(health, "LFM2.5-2.6B-GGUF")?.id, "LFM2.5-2.6B-GGUF");
  });

  it("trusts the type over the recipe, so a new engine needs no list", () => {
    /* An engine MyRA has never heard of, doing speech. The recipe list would
       have admitted it; the daemon's own word excludes it on day one. */
    const future = parseHealth({
      all_models_loaded: [
        { model_name: "NewVoice-1", recipe: "some-new-engine", type: "tts", status: "ready" },
        { model_name: "Chatty-7B", recipe: "some-new-engine", type: "llm", status: "ready" },
      ],
    });
    assert.equal(chatModelOf(future)?.id, "Chatty-7B");
  });

  it("falls back to the recipe when the daemon sends no type", () => {
    const older = parseHealth({
      all_models_loaded: [
        { model_name: "Whisper-Tiny", recipe: "whispercpp", status: "ready" },
        { model_name: "Qwen3-8B", recipe: "llamacpp", status: "ready" },
      ],
    });
    assert.equal(chatModelOf(older)?.id, "Qwen3-8B");
  });
});

describe("isChatEngine", () => {
  it("falls back to the hardcoded recipe list when no labels are given", () => {
    assert.equal(isChatEngine("llamacpp"), true);
    assert.equal(isChatEngine("whispercpp"), false);
    assert.equal(isChatEngine("sd-cpp"), false);
    assert.equal(isChatEngine(undefined), true, "no recipe at all is not treated as non-chat");
  });

  it("prefers labels over the recipe list once the caller has a catalogue entry", () => {
    /* A recipe this file's own Set has never heard of -- a future engine, or
       one simply not added yet -- is exactly the case a hardcoded list gets
       wrong by construction. Labels come from the same catalogue entry a
       caller already has in hand, so it should never need to fall back to
       guessing from the recipe name at all. */
    assert.equal(isChatEngine("a-future-engine", ["image"]), false);
    assert.equal(isChatEngine("a-future-engine", ["chat"]), true);
    // Labels win even when they'd disagree with the recipe list's own answer.
    assert.equal(isChatEngine("llamacpp", ["image"]), false);
    assert.equal(isChatEngine("sd-cpp", ["chat"]), true);
  });
});

describe("putting the chat model back when something took it away", () => {
  const chat = { id: "Qwen3-8B", recipe: "llamacpp", type: "llm", ready: true };
  const base = { useForChat: true, ready: true, resolved: undefined, activeModel: "Qwen3-8B" };

  it("reloads the chosen model after the daemon evicts it", () => {
    /* Lemonade does this by itself: "Load failed with non-file-not-found
       error, evicting all models and retrying" dropped a user's chat model to
       make room for a Whisper that then failed anyway. Before this, the only
       way back was to reopen the menu and pick the same model again. */
    assert.equal(chatModelToReload(base), "Qwen3-8B");
  });

  it("does nothing when the model is already there", () => {
    assert.equal(chatModelToReload({ ...base, resolved: chat }), undefined);
  });

  it("does not start a daemon that is deliberately stopped", () => {
    /* An 8 GB process should not appear because somebody typed a message --
       which is the whole meaning of startOnLaunch being off. */
    assert.equal(chatModelToReload({ ...base, ready: false }), undefined);
  });

  it("leaves 'None selected' alone when nothing was ever chosen", () => {
    assert.equal(chatModelToReload({ ...base, activeModel: undefined }), undefined);
    assert.equal(chatModelToReload({ ...base, activeModel: "   " }), undefined);
  });

  it("never reloads a speech model into the conversation's slot", () => {
    /* A record written before speech models were kept out of activeModel can
       still name one. Reloading it would hold a transcription model open for a
       conversation it cannot answer. */
    assert.equal(chatModelToReload({ ...base, activeModel: "Whisper-Large-v3-Turbo",
      recipe: "whispercpp" }), undefined);
    assert.equal(chatModelToReload({ ...base, recipe: "llamacpp" }), "Qwen3-8B");
  });

  it("prefers the catalogue's own labels over the hardcoded recipe list when both are given", () => {
    /* A recipe NON_CHAT_RECIPES has never heard of -- a future engine, or one
       simply not added to that list yet -- is exactly the case the hardcoded
       Set cannot get right on its own; labels, from the same catalogue entry
       manager.ts already has in hand, decide it instead. */
    assert.equal(
      chatModelToReload({ ...base, recipe: "a-future-engine", labels: ["image"] }),
      undefined,
      "labelled as image, not chat, whatever the recipe is called",
    );
    assert.equal(
      chatModelToReload({ ...base, recipe: "a-future-engine", labels: ["chat"] }),
      "Qwen3-8B",
      "labelled chat, so it reloads even though the recipe is unrecognised",
    );
  });

  it("stays out of it when the local backend is not the one answering", () => {
    assert.equal(chatModelToReload({ ...base, useForChat: false }), undefined);
  });
});

describe("executableName", () => {
  it("looks for the daemon under the name the archive actually uses", () => {
    /* Every Windows install failed at the last step with "the Lemonade download
       contained no daemon": lemondName() already carries the extension, and the
       search appended a second one, so it hunted for lemond.exe.exe. */
    assert.equal(executableName(lemondName("win32"), "win32"), "lemond.exe");
    assert.equal(executableName(lemondName("linux"), "linux"), "lemond");
  });

  it("still adds one for a caller that passes a bare name", () => {
    // pandoc is found this way: `pandoc-3.10.2/pandoc.exe` in the archive.
    assert.equal(executableName("pandoc", "win32"), "pandoc.exe");
    assert.equal(executableName("pandoc", "linux"), "pandoc");
  });
});

/**
 * A version bump without its hashes must fail here, not at install time.
 *
 * `installLemonade` refuses an asset it has no pinned sha256 for, which is the
 * right behaviour at runtime and a terrible way to find out. This is the
 * mechanism that actually keeps the table current: change LEMONADE_VERSION and
 * this test names the four assets that now need entries.
 */
describe("the daemon archive is pinned", () => {
  it("has a checksum for every build MyRA can ask for", () => {
    const wanted: string[] = [];
    for (const platform of ["linux", "darwin", "win32"]) {
      for (const arch of ["x64", "arm64"]) {
        const asset = embeddableAsset(platform, arch);
        if (asset) wanted.push(asset);
      }
    }
    assert.ok(wanted.length >= 4, "the platform matrix should still produce assets");
    for (const asset of wanted) {
      const sha = embeddableSha256(asset);
      assert.ok(sha, `no sha256 pinned for ${asset} -- add it when bumping LEMONADE_VERSION`);
      assert.match(sha, /^[0-9a-f]{64}$/, `${asset} has a malformed sha256`);
    }
  });

  it("carries no rows left over from an older version", () => {
    // A stale row is a hash for an archive nothing will ever ask for, which
    // reads as coverage and is not.
    for (const asset of Object.keys(EMBEDDABLE_SHA256)) {
      assert.ok(
        asset.includes(LEMONADE_VERSION),
        `${asset} is left over from an older version of the pin`,
      );
    }
  });
});
