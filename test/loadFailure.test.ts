/**
 * The failure a user actually met, and what they should have been told.
 *
 * Reported verbatim from a running install: dictation ended and the window
 * showed
 *
 *   Error invoking remote method 'myra:dictation-stop': TranscriptionError:
 *   Transcription failed: 500 Internal Server Error — {"error":{"code":
 *   "model_load_error","message":"Failed to load model
 *   'Whisper-Large-v3-Turbo': whisper-server failed to start or become ready",
 *   ...}}
 *
 * Two separate faults in one line: Electron's wrapper around a handler that
 * threw, and a raw daemon body standing in for an explanation. This covers the
 * second; `dictation-stop` returning a result rather than throwing covers the
 * first.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  explainIfLoadFailure, explainLoadFailure, loadFailureIn, producedNothing,
} from "../src/core/models/loadFailure.ts";

/** The body exactly as the daemon sent it. */
const REPORTED =
  'Transcription failed: 500 Internal Server Error — {"error":{"code":"model_load_error",' +
  '"message":"Failed to load model \'Whisper-Large-v3-Turbo\': whisper-server failed to ' +
  'start or become ready","param":"model","requested_model":"Whisper-Large-v3-Turbo",' +
  '"type":"model_load_error"}}';

describe("recognising a model that would not load", () => {
  it("finds the model in the body the daemon actually sent", () => {
    assert.deepEqual(loadFailureIn(REPORTED), { model: "Whisper-Large-v3-Turbo" });
  });

  it("reads the prose form too, for a client that only kept the message", () => {
    assert.deepEqual(
      loadFailureIn("Failed to load model 'Kokoro-v1': backend would not start"),
      { model: "Kokoro-v1" },
    );
  });

  it("leaves every other failure alone", () => {
    /* These have messages that say more than this one could, and overwriting
       them would be a downgrade. */
    assert.equal(loadFailureIn("The transcription model did not answer within 120s."), undefined);
    assert.equal(loadFailureIn("Transcription failed: 401 Unauthorized"), undefined);
    assert.equal(loadFailureIn("Could not reach the voice model: fetch failed"), undefined);
  });
});

describe("what to say instead", () => {
  it("names the model, the engine, and the screen that fixes it", () => {
    const said = explainIfLoadFailure(REPORTED, { role: "transcription", engine: "whispercpp" });
    assert.ok(said);
    assert.match(said, /Whisper-Large-v3-Turbo/);
    assert.match(said, /whispercpp engine/);
    assert.match(said, /Settings → Runtime/);
    /* The point of the sentence: the engine is a separate install from the one
       that answers chat, which is the fact nothing on screen said. */
    assert.match(said, /installed separately/);
  });

  it("does not claim the engine is missing, because it may be crashing", () => {
    /* An installed engine that dies on startup produces this same error. The
       daemon's log is what tells the two apart, so the sentence points there
       rather than asserting which it is. */
    const said = explainLoadFailure({ model: "Whisper-Base" }, {
      role: "transcription",
      engine: "whispercpp",
    });
    assert.match(said, /failing to start/);
    assert.equal(/is not installed\b/.test(said), false);
  });

  it("still works when the engine is unknown, as it is for a provider", () => {
    const said = explainLoadFailure({ model: "some-model" }, { role: "image", engine: undefined });
    assert.match(said, /some-model/);
    assert.match(said, /engine of its own/);
    // The verb follows the role: you draw with an image model.
    assert.match(said, /to draw with/);
  });

  it("uses each role's own verb", () => {
    const voice = explainLoadFailure({ model: "Kokoro-v1" }, { role: "voice", engine: "kokoro" });
    assert.match(voice, /to speak with/);
  });

  it("copes with a body that names no model at all", () => {
    const said = explainIfLoadFailure('{"error":{"code":"model_load_error"}}', {
      role: "transcription",
      engine: "whispercpp",
    });
    assert.ok(said);
    assert.match(said, /the transcription model would not load/);
  });
});

describe("which of the three failures this was", () => {
  /* The one that was said wrongly: whisper.cpp installed, whisper-server
     spawned with a PID and exiting 100 ms later, and MyRA answering "open
     Settings → Runtime to install it". The daemon knew; nothing asked it. */
  it("does not send someone to install an engine they already have", () => {
    const said = explainLoadFailure({ model: "Whisper-Large-v3-Turbo" }, {
      role: "transcription",
      engine: "whispercpp",
      engineState: "ready",
    });
    assert.match(said, /is installed/);
    assert.equal(/to install it/.test(said), false);
    // What actually happened, and the two things that cause it.
    assert.match(said, /exiting as soon as it started/);
    assert.match(said, /did not finish downloading/);
    assert.match(said, /Settings → Runtime/);
  });

  it("names the old system when MyRA already had to work around it", () => {
    /* The reported case, measured: whisper-server v1.8.4 and kokoro's koko b17
       both need GLIBC_2.38; llama.cpp b10375 needs 2.34. So on a machine that
       needed a bundled C runtime for the daemon, chat works and every speech
       model exits code 1 in under a second -- and the user reasonably concludes
       something about MyRA is broken rather than something about the box. */
    const said = explainLoadFailure({ model: "Whisper-Large-v3-Turbo" }, {
      role: "transcription",
      engine: "whispercpp",
      engineState: "ready",
      oldSystem: true,
    });
    assert.match(said, /newer system libraries/);
    // The asymmetry is the confusing part, so it is stated rather than implied.
    assert.match(said, /chat keeps working/);
    // MyRA wraps these engines itself, so this says the wrap failed, not that
    // the machine is out of luck -- and names the thing that retries it.
    assert.match(said, /Restarting MyRA/);
    // Nothing to install and nothing to re-download: neither would help.
    assert.equal(/finish downloading/.test(said), false);
    assert.equal(/to install it/.test(said), false);
  });

  it("says plainly that the engine is missing when it is", () => {
    const said = explainLoadFailure({ model: "Kokoro-v1" }, {
      role: "voice",
      engine: "kokoro",
      engineState: "needs-engine",
    });
    assert.match(said, /not installed yet/);
    assert.match(said, /Settings → Runtime/);
  });

  it("does not offer an install that cannot work", () => {
    /* `unsupported` means no backend for this hardware. Telling somebody to
       install it sends them to a screen with nothing to press. */
    const said = explainLoadFailure({ model: "Some-NPU-Model" }, {
      role: "transcription",
      engine: "ryzenai-llm",
      engineState: "unsupported",
    });
    assert.match(said, /no way to run/);
    assert.match(said, /another model/);
    assert.equal(/install it/.test(said), false);
  });

  it("keeps hedging when the daemon could not be asked", () => {
    // No state: the daemon is down, or was not reachable at the moment it failed.
    const said = explainLoadFailure({ model: "Whisper-Base" }, {
      role: "transcription",
      engine: "whispercpp",
    });
    assert.match(said, /installed separately/);
    assert.match(said, /failing to start/);
  });
});

describe("an engine that answers with nothing", () => {
  /* The reported body, from the daemon: an sd-cpp server on the CUDA backend
     that started, passed its readiness check, and returned this in 250 ms. The
     same request on the Vulkan backend took 33 seconds and returned a PNG, so
     an instant empty answer is a backend fault, not a slow model. */
  const REPORTED_IMAGE =
    'Generating the image failed: 500 Internal Server Error — {"error":{"details":{"backend":' +
    '"sd-server","response":{"error":"generate_image returned no results"}},"message":' +
    '"generate_image returned no results","status_code":500,"type":"backend_error"}}';

  it("recognises it, and does not mistake it for a model that would not load", () => {
    assert.equal(producedNothing(REPORTED_IMAGE), true);
    assert.equal(loadFailureIn(REPORTED_IMAGE), undefined);
  });

  it("names what is holding the card, which is what the user can act on", () => {
    /* The measured cause, from running the engine by hand because the daemon
       throws its stderr away: `cudaMalloc failed: out of memory` allocating
       1411 MiB on an RTX 4060 that already held a 30B chat model, Whisper and
       Kokoro. Lemonade's max_loaded_models is 1 per TYPE, so it holds one of
       each and never evicts across pools. */
    const said = explainIfLoadFailure(REPORTED_IMAGE, {
      role: "image",
      engine: "sd-cpp",
      gpuResident: ["NVIDIA-Nemotron-3-Nano-30B-A3B", "Whisper-Large-v3-Turbo", "kokoro-v1"],
    });
    assert.ok(said);
    assert.match(said, /graphics card being full/);
    assert.match(said, /Whisper-Large-v3-Turbo/);
    assert.match(said, /eject button/);
    // Not a backend problem, so it must not send anyone to reinstall one.
    assert.equal(/install/.test(said), false);
  });

  it("blames the backend only when nothing else is on the card", () => {
    const said = explainIfLoadFailure(REPORTED_IMAGE, { role: "image", engine: "sd-cpp" });
    assert.ok(said);
    assert.match(said, /sd-cpp engine/);
    assert.match(said, /nothing is missing/);
    assert.match(said, /Settings → Runtime/);
    // Nothing to install and nothing to download: neither is the problem here.
    assert.equal(/did not finish downloading/.test(said), false);
  });

  it("still leaves unrelated failures alone", () => {
    assert.equal(producedNothing("Generating the image failed: 401 Unauthorized"), false);
    assert.equal(
      explainIfLoadFailure("The image model did not answer in fifteen minutes.", { role: "image" }),
      undefined,
    );
  });
});
