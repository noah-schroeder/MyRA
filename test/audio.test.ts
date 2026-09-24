/**
 * The audio path: which model, which voice, and what gets read aloud.
 *
 * The facts asserted about Lemonade here were measured against a running
 * 11.8.0 daemon rather than read from documentation, because there is no
 * documentation to read -- it publishes no OpenAPI document and no voice
 * listing. Where a test encodes something measured, the comment says so, since
 * that is the only way a future reader can tell a decision from a guess.
 */

import assert from "node:assert/strict";
import { test, describe, it } from "node:test";

import {
  describeVoice, isKokoro, voicesFor, voiceForModel, voiceIsValid, KOKORO_VOICE_IDS, DEFAULT_VOICE,
} from "../src/core/audio/voices.ts";
import { fitsRole, guessRole, hasVision, localFitsChat, modelNamer } from "../src/core/models/roles.ts";
import { modelOptions } from "../src/main/models.ts";
import {
  audioMime, refusedTheFormat, sniffAudio,
} from "../src/core/audio/container.ts";
import { isForRole, isProviderRef, modelIdOf } from "../src/core/audio/models.ts";
import { speakable, MAX_SPOKEN_CHARS } from "../src/core/audio/speakable.ts";
import { speechUrl, speak, SpeechError } from "../src/core/audio/speech.ts";
import { chatModelOf, isChatEngine, parseHealth } from "../src/core/runtime/lemonade.ts";
import { ConfigStore, DEFAULT_AUDIO } from "../src/core/config.ts";
import { CONFIG_DIR } from "../src/core/paths.ts";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";

const SETTINGS = join(CONFIG_DIR, "settings.json");

async function withSettings(body: unknown, fn: (s: ConfigStore) => Promise<void>): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(SETTINGS, JSON.stringify(body));
  try {
    const store = new ConfigStore();
    await store.load();
    await fn(store);
  } finally {
    await rm(SETTINGS, { force: true });
  }
}

/* ------------------------------------------------------------------ voices */

describe("voices", () => {
  test("every shipped voice was one the daemon accepted", () => {
    // All forty were POSTed to kokoro-v1 and returned audio; `not_a_real_voice`
    // returned 500. The list is evidence, so it must not grow by guesswork.
    assert.equal(KOKORO_VOICE_IDS.length, 40);
    assert.ok(KOKORO_VOICE_IDS.includes(DEFAULT_VOICE));
    assert.ok(KOKORO_VOICE_IDS.every((id) => /^[abefhijpz][fm]_[a-z]+$/.test(id)));
  });

  test("a name and a language are read out of the id", () => {
    assert.deepEqual(describeVoice("af_heart"), {
      id: "af_heart", name: "Heart", language: "American English", gender: "female",
    });
    assert.deepEqual(describeVoice("bm_george"), {
      id: "bm_george", name: "George", language: "British English", gender: "male",
    });
    assert.equal(describeVoice("zf_xiaobei").language, "Mandarin Chinese");
  });

  test("a voice from an engine MyRA does not know is shown, not dropped", () => {
    // The field takes free text precisely so an unknown engine can be used, and
    // a parser that threw here would make that field unusable.
    const odd = describeVoice("Rachel");
    assert.equal(odd.id, "Rachel");
    assert.equal(odd.name, "Rachel");
    assert.equal(odd.language, "");
  });

  test("voices are offered only where they are knowable", () => {
    assert.equal(voicesFor("kokoro-v1").length, 40);
    // Not a failure: it means "use a text box", because no endpoint anywhere
    // will enumerate a hosted provider's voices.
    assert.deepEqual(voicesFor("gpt-4o-mini-tts"), []);
    assert.ok(isKokoro("Kokoro-v1"));
    assert.ok(!isKokoro("Whisper-Base"));
  });

  test("a voice is only refused when the list is known to exclude it", () => {
    assert.ok(voiceIsValid("kokoro-v1", "af_sky"));
    assert.ok(!voiceIsValid("kokoro-v1", "af_nonexistent"));
    // Unknown engine: anything goes, including nothing.
    assert.ok(voiceIsValid("some-tts", "Rachel"));
    assert.ok(voiceIsValid("kokoro-v1", ""));
  });
});

/* ------------------------------------------------------------------- roles */

describe("which model does which job", () => {
  test("the labels decide, not the name", () => {
    // Measured from /api/v1/models: Whisper carries both transcription labels,
    // Kokoro carries tts, and a chat model carries neither.
    assert.ok(isForRole(["transcription", "realtime-transcription"], "transcription"));
    assert.ok(isForRole(["tts"], "voice"));
    assert.ok(!isForRole(["tts"], "transcription"));
    assert.ok(!isForRole(["custom", "chat", "tool-calling"], "transcription"));
    assert.ok(!isForRole(undefined, "voice"));
  });

  test("vision reads the same catalogue labels the vision browse group declares", () => {
    assert.ok(hasVision(["chat", "vision", "tool-calling"]));
    assert.ok(hasVision(["chat", "omni"]));
    assert.ok(!hasVision(["chat", "tool-calling"]));
    // Unknown, not a refusal: a custom-labelled model's labels are a guess and
    // a hosted provider reports none at all -- neither is a reason to block an
    // image, only a reason to warn before sending it.
    assert.ok(!hasVision(undefined));
    assert.ok(!hasVision([]));
  });

  test("an image model is picked out by the same field", () => {
    /* `image` is the label the catalogue already groups diffusion models
       under, so the image picker reads a field the rest of the app writes
       rather than matching the id against /sd|diffusion/ and being wrong for
       the next model anyone renames. */
    assert.ok(isForRole(["image"], "image"));
    assert.ok(!isForRole(["image"], "voice"));
    assert.ok(!isForRole(["image"], "transcription"));
    assert.ok(!isForRole(["tts"], "image"));
    assert.ok(!isForRole(["chat", "tool-calling"], "image"));
  });

  test("streaming speech models are still speech models", () => {
    // All three Moonshine entries carry only `realtime-transcription` alongside
    // `transcription`; excluding it would have hidden them from the picker.
    assert.ok(isForRole(["realtime-transcription"], "transcription"));
  });

  test("a reference says where the model runs", () => {
    assert.ok(!isProviderRef("Whisper-Base"));
    assert.ok(isProviderRef("p3::whisper-1"));
    // The qualifier is "::" because model ids contain "/" and ":" themselves --
    // an Ollama-style `qwen2.5:7b` is a bare local name, not a provider ref.
    assert.ok(!isProviderRef("qwen2.5:7b"));
    assert.ok(!isProviderRef("org/repo-GGUF"));
    // The qualifier must never reach the request body: no server can answer a
    // model called `p3::whisper-1`.
    assert.equal(modelIdOf("p3::whisper-1"), "whisper-1");
    assert.equal(modelIdOf("Whisper-Base"), "Whisper-Base");
  });
});

/* -------------------------------------------------- chat versus the daemon */

describe("a speech model must not become the chat model", () => {
  /*
   * The measured failure this guards.
   *
   * Lemonade holds several models at once, each on its own backend port, and
   * `model_loaded` names whichever was touched LAST. Load a chat model,
   * transcribe one clip, and it reads `Whisper-Tiny` while the chat model is
   * still resident -- so routing chat by that field sent the next message to a
   * speech-to-text model.
   */
  const health = parseHealth({
    model_loaded: "Whisper-Tiny",
    all_models_loaded: [
      { model_name: "kokoro-v1", recipe: "kokoro", status: "ready", backend_url: "http://127.0.0.1:8001/v1" },
      {
        model_name: "LiquidAI__LFM2.5-2.6B-GGUF", recipe: "llamacpp", status: "ready",
        backend_url: "http://127.0.0.1:8002/v1", recipe_options: { ctx_size: 4096 },
      },
      { model_name: "Whisper-Tiny", recipe: "whispercpp", status: "ready", backend_url: "http://127.0.0.1:8003/v1" },
    ],
  });

  test("all three loaded models are kept, not just the last one", () => {
    assert.equal(health.models.length, 3);
    assert.equal(health.modelLoaded, "Whisper-Tiny");
  });

  test("the model MyRA loaded on purpose wins", () => {
    const chosen = chatModelOf(health, "LiquidAI__LFM2.5-2.6B-GGUF");
    assert.equal(chosen?.id, "LiquidAI__LFM2.5-2.6B-GGUF");
    assert.equal(chosen?.contextTokens, 4096);
  });

  test("with nothing preferred, a chat engine is still chosen over Whisper", () => {
    assert.equal(chatModelOf(health, undefined)?.id, "LiquidAI__LFM2.5-2.6B-GGUF");
    // And the stale preference of a model that has been unloaded does not win.
    assert.equal(chatModelOf(health, "SomeModelNoLongerLoaded")?.id, "LiquidAI__LFM2.5-2.6B-GGUF");
  });

  test("a daemon holding only speech models can offer no chat model", () => {
    const speechOnly = parseHealth({
      model_loaded: "Whisper-Tiny",
      all_models_loaded: [
        { model_name: "Whisper-Tiny", recipe: "whispercpp", status: "ready" },
        { model_name: "kokoro-v1", recipe: "kokoro", status: "ready" },
      ],
    });
    // Naming one of these would produce a request that fails at the far end,
    // under a picker claiming a model was ready.
    assert.equal(chatModelOf(speechOnly, undefined), undefined);
  });

  test("an unknown engine is assumed to be a chat engine", () => {
    // The catalogue gains recipes over time, and refusing to chat with one
    // MyRA has not heard of would break on an upgrade rather than on a bug.
    assert.ok(isChatEngine("vllm"));
    assert.ok(isChatEngine(undefined));
    assert.ok(!isChatEngine("whispercpp"));
    assert.ok(!isChatEngine("kokoro"));
  });

  test("the engines that make pictures, audio and 3D are not chat engines", () => {
    /*
     * `thenoise` is why this exists. It runs seven image models in Lemonade's
     * catalogue and was missing from the list, so `startOnLaunch` would have
     * loaded one as the model a conversation goes to -- the same failure the
     * comment there describes for speech models, which is how that gate is
     * known to be recipe-only rather than covered by the daemon's `type`.
     *
     * Every recipe here is one whose catalogue models carry no chat label at
     * all. `ds4` is deliberately not among them: its models are labelled
     * `chat`, whatever else the engine can do.
     */
    for (const recipe of ["thenoise", "acestep", "thinksound", "trellis", "sd-cpp"]) {
      assert.ok(!isChatEngine(recipe), `${recipe} should not be a chat engine`);
    }
    assert.ok(isChatEngine("ds4"));
  });
});

/* --------------------------------------------------------------- speakable */

describe("what is worth reading aloud", () => {
  test("a code block is described rather than recited", () => {
    const said = speakable("Here is the fix:\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nThat is all.");
    assert.match(said, /2 lines of code/);
    assert.ok(!said.includes("const"));
    assert.ok(said.startsWith("Here is the fix"));
    assert.ok(said.endsWith("That is all."));
  });

  test("a table is counted, not read cell by cell", () => {
    const said = speakable("Results:\n\n| n | p |\n|---|---|\n| 1 | .04 |\n| 2 | .07 |\n\nDone.");
    // Three rows minus the header: the separator line is not a row, and
    // counting it reported one more row than the table has.
    assert.match(said, /a table of 2 rows/);
    assert.ok(!said.includes("|"));
  });

  test("citation markers are dropped, because a listener cannot see them", () => {
    const said = speakable("This held in two trials [3], though not a third [4, 7].");
    assert.ok(!said.includes("[3]"));
    assert.ok(!said.includes("[4, 7]"));
    // And the gap closes: "two trials ," is read with a pause where no pause
    // belongs. Seen against a live Kokoro before this was fixed.
    assert.equal(said, "This held in two trials, though not a third.");
  });

  test("a link is worth its text and not its URL", () => {
    assert.equal(
      speakable("See [the preprint](https://arxiv.org/abs/2401.00001) for detail."),
      "See the preprint for detail.",
    );
  });

  test("headings, bullets and emphasis lose their punctuation and keep their words", () => {
    const said = speakable("## Findings\n\n- **First** point\n- _Second_ point\n");
    assert.equal(said, "Findings\n\nFirst point\nSecond point");
  });

  test("a numbered list keeps its numbers", () => {
    // The number is the content in an ordered list; dropping it makes three
    // steps into one undifferentiated paragraph.
    assert.match(speakable("1. Wash it\n2. Dry it"), /1\. Wash it/);
  });

  test("a very long answer is cut at a sentence and says that it was", () => {
    const long = `${"This is a sentence about the thing. ".repeat(400)}`;
    const said = speakable(long);
    assert.ok(said.length < MAX_SPOKEN_CHARS + 200);
    assert.match(said, /The rest of this answer is on screen\.$/);
    // Cut at a sentence rather than mid-word.
    assert.ok(!/\bThi\b|\bsente\b/.test(said));
  });

  test("inline code is spoken as the word it is", () => {
    assert.equal(speakable("Run `npm test` first."), "Run npm test first.");
  });
});

/* ------------------------------------------------------------------ speech */

describe("speaking", () => {
  test("a base URL is accepted with or without /v1", () => {
    assert.equal(speechUrl("http://127.0.0.1:8000"), "http://127.0.0.1:8000/v1/audio/speech");
    assert.equal(speechUrl("http://127.0.0.1:8000/v1"), "http://127.0.0.1:8000/v1/audio/speech");
    assert.equal(speechUrl("http://127.0.0.1:8000/v1/"), "http://127.0.0.1:8000/v1/audio/speech");
  });

  test("no model is a message about settings, not about a missing field", () => {
    // Lemonade answers `Missing 'model' field in request`, which is true and
    // useless to somebody who never typed a model name anywhere.
    return assert.rejects(
      () => speak({ endpoint: { baseUrl: "http://x/v1", envVar: "", timeoutMs: 1000 }, text: "hi" }),
      (err: Error) => err instanceof SpeechError && /Settings → Audio/.test(err.message),
    );
  });

  test("the container is read from the response, not assumed", async () => {
    /* Measured: the reply is MP3 whatever `response_format` asks for, so the
       request cannot decide this and the renderer has to be told what it is
       being handed. */
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04]), {
        status: 200,
        headers: { "content-type": "audio/mpeg; charset=binary" },
      })) as typeof fetch;
    try {
      const spoken = await speak({
        endpoint: { baseUrl: "http://x/v1", envVar: "", model: "kokoro-v1", timeoutMs: 1000 },
        text: "hello",
        voice: "af_heart",
      });
      assert.equal(spoken.mime, "audio/mpeg");
      assert.equal(spoken.audio.length, 4);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("an unknown voice is named as such rather than as a server fault", async () => {
    // The wire form is a bare `backend returned HTTP 500` with no mention of
    // the voice, so the only place this can be explained is here.
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('{"error":{"message":"backend returned HTTP 500"}}', { status: 500 })) as typeof fetch;
    try {
      await assert.rejects(
        () => speak({
          endpoint: { baseUrl: "http://x/v1", envVar: "", model: "kokoro-v1", timeoutMs: 1000 },
          text: "hello",
          voice: "af_nonexistent",
        }),
        (err: Error) => err instanceof SpeechError && /may not have that voice/.test(err.message),
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});

/* ------------------------------------------------------------------ config */

describe("the audio settings", () => {
  test("a pace outside what the slider can produce is clamped", async () => {
    const store = new ConfigStore();
    await store.load();
    const saved = await store.update({ audio: { ...DEFAULT_AUDIO, speed: 9 } });
    assert.equal(saved.audio.speed, DEFAULT_AUDIO.speed);
    const ok = await store.update({ audio: { ...DEFAULT_AUDIO, speed: 1.25 } });
    assert.equal(ok.audio.speed, 1.25);
  });

  test("an older build's transcription endpoint is picked up to be migrated", async () => {
    /*
     * The whole point of `legacyTranscription`: somebody pointing MyRA at
     * their own whisper server must not find transcription silently
     * unconfigured after an upgrade. The main process turns this into a
     * provider; what is asserted here is that the value survives the read at
     * all, which is the half that can be tested without Electron.
     */
    await withSettings(
      { transcription: { baseUrl: "http://whisper.lan:9000/v1", model: "large-v3", timeoutMs: 60_000 } },
      async (store) => {
        assert.equal(store.current.legacyTranscription?.baseUrl, "http://whisper.lan:9000/v1");
        assert.equal(store.current.legacyTranscription?.model, "large-v3");
        // And it is not mistaken for a chosen model in the meantime.
        assert.equal(store.current.audio.transcriptionModel, "");
      },
    );
  });

  test("an endpoint that was never filled in is nothing to migrate", async () => {
    // Every install that never configured one: the migration must return
    // immediately rather than creating an empty provider on first launch.
    await withSettings({ transcription: { baseUrl: "", model: "whisper-1" } }, async (store) => {
      assert.equal(store.current.legacyTranscription, undefined);
    });
  });

  test("the migration's own effect is what stops it running twice", async () => {
    // It is cleared by writing a settings file that no longer has the old key.
    // If a save kept writing one, every launch would migrate again and mint a
    // new provider each time.
    await withSettings(
      { transcription: { baseUrl: "http://whisper.lan:9000/v1", model: "large-v3", timeoutMs: 60_000 } },
      async (store) => {
        await store.update({ legacyTranscription: undefined });
        const written = JSON.parse(await readFile(SETTINGS, "utf8")) as Record<string, unknown>;
        assert.ok(!("transcription" in written));
        assert.ok(!("legacyTranscription" in written));

        const reopened = new ConfigStore();
        await reopened.load();
        assert.equal(reopened.current.legacyTranscription, undefined);
      },
    );
  });

  test("choosing a model does not clear the voice beside it", async () => {
    // The chat bar's picker sends one field, and a replace rather than a merge
    // would silently reset the voice every time somebody switched models.
    const store = new ConfigStore();
    await store.load();
    await store.update({ audio: { ...DEFAULT_AUDIO, voice: "bm_george", voiceModel: "kokoro-v1" } });
    const after = await store.update({
      audio: { ...store.current.audio, transcriptionModel: "Whisper-Base" },
    });
    assert.equal(after.audio.voice, "bm_george");
    assert.equal(after.audio.voiceModel, "kokoro-v1");
    assert.equal(after.audio.transcriptionModel, "Whisper-Base");
  });
});

/**
 * Two catalogue entries that shorten to the same words.
 *
 * The picker showed `SD-Turbo` and `SD-Turbo-GGUF` as two rows both reading
 * "SD-Turbo": one a 5.2 GB download, the other 2.0 GB, and nothing on screen
 * to tell them apart. Stripping the suffix is right for a model found in
 * another tool's folder and wrong when it is the only thing distinguishing two
 * offers.
 */
describe("naming models in a list", () => {
  // The real rule, so a change to it is caught here rather than on screen.
  const short = (id: string): string =>
    id.replace(/-(GGUF|(?:IQ|TQ|Q)\d+[\w.]*|BF16|F16|F32)$/i, "");

  it("keeps the full id for everything caught in a collision", () => {
    const name = modelNamer(["SD-Turbo", "SD-Turbo-GGUF", "Qwen-Image"], short);
    assert.equal(name("SD-Turbo"), "SD-Turbo");
    assert.equal(name("SD-Turbo-GGUF"), "SD-Turbo-GGUF");
    // Uncontested: the short form, which is the whole point of shortening.
    assert.equal(name("Qwen-Image"), "Qwen-Image");
  });

  it("shortens when nothing else claims the name", () => {
    const name = modelNamer(["Whisper-Large-v3-GGUF", "Whisper-Base"], short);
    assert.equal(name("Whisper-Large-v3-GGUF"), "Whisper-Large-v3");
  });

  it("answers for a model that is not in the list at all", () => {
    /* The bar asks about the model it has stored, which can be one the picker
       no longer offers -- a provider removed, a catalogue entry withdrawn. */
    const name = modelNamer(["SD-Turbo", "SD-Turbo-GGUF"], short);
    assert.equal(name("Flux-2-Klein-4B-Q4"), "Flux-2-Klein-4B");
  });
});

/**
 * A voice belongs to an engine, and the two are set from different screens.
 *
 * Choose Kokoro, pick a voice, then switch the voice model to a hosted one:
 * the Kokoro voice name stayed in the settings and went out with every request
 * to a provider that has never heard of it. Kokoro's own answer to an unknown
 * voice is a bare HTTP 500, so the symptom is a feature that worked yesterday
 * failing on every answer with the cause two panes away.
 */
describe("keeping the voice and its model in step", () => {
  it("drops a Kokoro voice when the model is no longer Kokoro", () => {
    assert.equal(voiceForModel("provider::eleven-turbo", "af_heart"), "");
    // Empty is legal: speak() omits the field and the engine picks its own.
    assert.equal(voiceForModel("", "am_michael"), "");
  });

  it("keeps a voice typed in for an engine MyRA cannot enumerate", () => {
    /* The free-text box exists precisely so an unknown engine's voices can be
       used, so its contents must survive this. */
    assert.equal(voiceForModel("provider::eleven-turbo", "Rachel"), "Rachel");
  });

  it("puts Kokoro back on a voice it actually has", () => {
    assert.equal(voiceForModel("kokoro-v1", "af_sky"), "af_sky");
    assert.equal(voiceForModel("kokoro-v1", "Rachel"), DEFAULT_VOICE);
  });

  it("leaves an unset voice unset", () => {
    assert.equal(voiceForModel("kokoro-v1", ""), "");
    assert.equal(voiceForModel("kokoro-v1", "   "), "");
  });
});

/**
 * Which engine a model needs, carried to the place it is chosen.
 *
 * Lemonade installs engines one recipe at a time, and installing the one that
 * answers chat installs none of the others. So a picker that does not know a
 * model's recipe cannot warn, and the first sign of trouble is
 * "whisper-server failed to start or become ready" at the end of a dictated
 * sentence — which is exactly how this was found.
 */
describe("what a model needs to run", () => {
  const deps = (installed: { id: string; downloaded?: boolean; labels?: string[] }[]) => ({
    config: { current: { providers: [] } },
    runtime: {
      lemonade: { status: { state: "ready", health: { loaded: [] } } },
      installedModels: async () => installed,
      catalog: async () => [
        { id: "Whisper-Large-v3-Turbo", recipe: "whispercpp", labels: ["transcription"],
          suggested: true, source: "huggingface", sizeBytes: 1_600_000_000 },
        { id: "kokoro-v1", recipe: "kokoro", labels: ["tts"], suggested: true, source: "huggingface" },
      ],
    },
  }) as unknown as Parameters<typeof modelOptions>[0];

  it("puts the engine on a model that has not been downloaded yet", async () => {
    const options = await modelOptions(deps([]), "transcription");
    const whisper = options.find((o) => o.model === "Whisper-Large-v3-Turbo");
    assert.equal(whisper?.recipe, "whispercpp");
  });

  it("puts it on one that IS downloaded, which /models does not report", async () => {
    /* The daemon's model listing carries no recipe, so an installed model would
       otherwise be the one row that could not be warned about -- and it is the
       row most likely to be chosen. */
    const options = await modelOptions(
      deps([{ id: "Whisper-Large-v3-Turbo", downloaded: true, labels: ["transcription"] }]),
      "transcription",
    );
    const whisper = options.find((o) => o.model === "Whisper-Large-v3-Turbo");
    assert.equal(whisper?.downloaded, true);
    assert.equal(whisper?.recipe, "whispercpp");
  });
});

/**
 * Which of a provider's models belongs in which list.
 *
 * A provider's /v1/models is ids and nothing else — no labels, no capability
 * field — so every model was offered for every job: `gpt-4o` as something that
 * could transcribe a meeting, `whisper-1` as something that could hold a
 * conversation. The guess below decides what is offered first; the menu keeps
 * everything else one click away, so being wrong costs a click and not a
 * model.
 */
describe("guessing what a provider's model is for", () => {
  it("recognises the transcribers", () => {
    for (const id of ["whisper-1", "gpt-4o-transcribe", "nova-2", "deepgram-nova-3", "canary-1b"]) {
      assert.equal(guessRole(id), "transcription", id);
    }
  });

  it("recognises the voices", () => {
    for (const id of ["tts-1", "gpt-4o-mini-tts", "eleven-turbo-v2", "kokoro-v1"]) {
      assert.equal(guessRole(id), "voice", id);
    }
  });

  it("recognises the image models", () => {
    for (const id of ["dall-e-3", "flux-pro", "stable-diffusion-3.5", "imagen-3"]) {
      assert.equal(guessRole(id), "image", id);
    }
  });

  it("leaves a chat model alone, including the ones with a job in the name", () => {
    /* `gpt-4o-transcribe` and `gpt-4o-mini-tts` both contain a chat model's
       name, which is why the specific patterns are tested first -- and why
       plain `gpt-4o` must still come out as chat. */
    for (const id of ["gpt-4o", "claude-opus-4-5-20251101", "gemini-3.8-flash", "qwen3-30b"]) {
      assert.equal(guessRole(id), "chat", id);
    }
  });

  it("answers the question each picker actually asks", () => {
    assert.equal(fitsRole("whisper-1", "transcription"), true);
    assert.equal(fitsRole("whisper-1", "chat"), false);
    assert.equal(fitsRole("gpt-4o", "chat"), true);
    assert.equal(fitsRole("gpt-4o", "voice"), false);
  });
});

describe("what the voice model actually handed back", () => {
  const bytes = (...parts: (string | number[])[]): Uint8Array => {
    const out: number[] = [];
    for (const p of parts) {
      if (typeof p === "string") for (const c of p) out.push(c.charCodeAt(0));
      else out.push(...p);
    }
    return new Uint8Array(out);
  };

  it("recognises each container from its own first bytes", () => {
    /* Measured against the local daemon, which returns exactly these for
       response_format wav / mp3 / opus. */
    assert.equal(sniffAudio(bytes("RIFF", [0, 0, 0, 0], "WAVEfmt ")), "audio/wav");
    assert.equal(sniffAudio(bytes("ID3", [3, 0, 0, 0])), "audio/mpeg");
    assert.equal(sniffAudio(bytes("OggS", [0, 2, 0, 0])), "audio/ogg");
    assert.equal(sniffAudio(bytes("fLaC", [0, 0, 0, 0])), "audio/flac");
    assert.equal(sniffAudio(bytes([0, 0, 0, 32], "ftypM4A ")), "audio/mp4");
    // An MP3 with no ID3 tag, which is a bare frame sync.
    assert.equal(sniffAudio(bytes([0xff, 0xfb, 0x90, 0x00])), "audio/mpeg");
  });

  it("says nothing about bytes it does not recognise", () => {
    // Undefined means "trust the header", not "refuse to play it".
    assert.equal(sniffAudio(bytes("nope")), undefined);
    assert.equal(sniffAudio(new Uint8Array([1, 2])), undefined);
  });

  it("believes the bytes over the header", () => {
    /* The failure this exists for: a Blob typed from a header that did not
       match its content reaches the window as "Failed to load because no
       supported source was found", indistinguishable from a voice model that
       answered with silence. */
    assert.equal(audioMime(bytes("RIFF", [0, 0, 0, 0], "WAVE"), "audio/mpeg"), "audio/wav");
  });

  it("throws away a header that says nothing", () => {
    // What a server sends when it has not thought about it. Chromium will not
    // sniff a Blob, so passing this on is the difference between sound and none.
    assert.equal(audioMime(bytes("nope"), "application/octet-stream"), "audio/mpeg");
    assert.equal(audioMime(bytes("nope"), undefined), "audio/mpeg");
    assert.equal(audioMime(bytes("nope"), "audio/l16;rate=24000"), "audio/l16");
  });

  it("only retries without the format when that is what was refused", () => {
    assert.equal(refusedTheFormat(400, '{"error":"unsupported response_format"}'), true);
    assert.equal(refusedTheFormat(400, '{"error":"model not found"}'), false);
    assert.equal(refusedTheFormat(500, "response_format"), false);
  });
});

describe("keeping the chat list to models you can talk to", () => {
  it("recognises an embedding model by name, for a model with no labels", () => {
    /* Seen in the chat menu of a running build: `embeddinggemma-300M-GGUF`,
       offered as something to hold a conversation with. It came from an LM
       Studio folder MyRA indexed, and the daemon only labels what is in its
       own catalogue -- so the label test had nothing to test and the name was
       the only fact available. */
    assert.equal(guessRole("embeddinggemma-300M-GGUF"), "embeddings");
    assert.equal(guessRole("nomic-embed-text-v1-GGUF"), "embeddings");
    assert.equal(guessRole("Qwen3-Embedding-0.6B-GGUF"), "embeddings");
    assert.equal(guessRole("bge-large-en-v1.5"), "embeddings");
    assert.equal(fitsRole("embeddinggemma-300M-GGUF", "chat"), false);
  });

  it("does not trust a `custom` label that says chat, because it is a default", () => {
    /* Measured on a running daemon: `embeddinggemma-300M-GGUF-Q8_0` comes back
       as ["chat", "custom"]. Lemonade labels anything registered from a folder
       that way because most GGUFs are chat models. For those the id is the
       better evidence -- and only for those. */
    assert.equal(localFitsChat("embeddinggemma-300M-GGUF-Q8_0", ["chat", "custom"]), false);
    assert.equal(localFitsChat("LiquidAI__LFM2.5-2.6B-GGUF", ["custom", "chat", "tool-calling"]), true);
    assert.equal(localFitsChat("bartowski__SmolLM2-135M-Instruct-GGUF", ["custom", "chat"]), true);
  });

  it("takes the daemon's own catalogue labels as fact", () => {
    // No `custom`: these came from Lemonade's catalogue and are known, not guessed.
    assert.equal(localFitsChat("Whisper-Large-v3-Turbo", ["transcription", "hot"]), false);
    assert.equal(localFitsChat("kokoro-v1", ["tts"]), false);
    assert.equal(localFitsChat("SD-Turbo-GGUF", ["image"]), false);
    /* A catalogue chat model whose name means nothing to the guesser is still
       offered -- the name test must not become a second fence. */
    assert.equal(localFitsChat("Bonsai-1.7B-gguf", ["chat"]), true);
  });

  it("falls back to the name when there are no labels at all", () => {
    assert.equal(localFitsChat("nomic-embed-text-v1-GGUF", []), false);
    assert.equal(localFitsChat("Qwen3-8B", undefined), true);
  });

  it("does not mistake an ordinary chat model for one", () => {
    /* The guess is only ever used where there is no label, so a false positive
       here hides a model somebody downloaded on purpose. */
    for (const id of ["Qwen3-8B", "LFM2.5-2.6B-GGUF", "Llama-3.3-70B-Instruct",
                      "gemma-3-27b-it", "Mistral-Small-Instruct"]) {
      assert.equal(guessRole(id), "chat", id);
    }
  });

  it("still tells the speech and image models apart", () => {
    assert.equal(guessRole("Whisper-Large-v3-Turbo"), "transcription");
    assert.equal(guessRole("kokoro-v1"), "voice");
    assert.equal(guessRole("SD-Turbo-GGUF"), "image");
  });
});
