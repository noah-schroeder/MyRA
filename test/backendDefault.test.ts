/**
 * The default runtime: what the daemon says, and the rules built on it.
 *
 * The payloads are what lemond 11.8.0 answered on 2026-09-30, not invented
 * ones -- most of this module is a reading of them, and a reading pinned to a
 * shape nobody measured is a reading of nothing. The cases that matter most
 * are the irregular ones: the image engine is `sd-cpp` in one place and
 * `sdcpp` in another, an engine with a single CPU build has no setting at
 * all, and a model's own choice has to be told apart from the default it
 * would otherwise get.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  AUTO,
  assertChoosable,
  backendLabel,
  changeNotice,
  chosenSentence,
  configKeyOf,
  configuredBackend,
  defaultChoices,
  describeChosen,
  engineBackendState,
  followSentence,
  installedRuntimes,
  modelChoice,
  optionKeyOf,
  resetLabel,
  tallyChosen,
} from "../src/core/runtime/backendDefault.ts";
import { parseModelOptions } from "../src/core/runtime/modelOptions.ts";

/** `GET /internal/config`, trimmed to the blocks that matter. */
const CONFIG = {
  llamacpp: { args: "", backend: "auto", cpu_bin: "builtin", rocm_bin: "builtin", vulkan_bin: "builtin" },
  whispercpp: { args: "", backend: "cpu", cpu_bin: "builtin" },
  sdcpp: { args: "--auto-fit", backend: "rocm", steps: 20 },
  // Kokoro and Moonshine ship a CPU build only, so there is nothing to choose.
  kokoro: { cpu_bin: "builtin" },
  moonshine: { args: "", cpu_args: "", cpu_bin: "builtin" },
  telemetry: { enabled: false },
};

/** `GET /api/v1/models/Qwen3-0.6B-GGUF/options` with the global default set to cpu. */
const LLAMA_OPTIONS = {
  model_name: "Qwen3-0.6B-GGUF",
  recipe: "llamacpp",
  defaults: { ctx_size: -1, llamacpp_args: "--parallel 1", llamacpp_backend: "cpu", llamacpp_device: "" },
  saved: { ctx_size: 8192, llamacpp_backend: "vulkan" },
  effective: { ctx_size: 8192, llamacpp_backend: "vulkan" },
};

describe("the daemon's two spellings of an engine", () => {
  it("writes the image engine's config block without its hyphen, and nothing else", () => {
    /* Measured: the config has `sdcpp`, a model has `sd-cpp_backend`. A single
       rule that derived both from the recipe would send the write to a block
       that does not exist. */
    assert.equal(configKeyOf("sd-cpp"), "sdcpp");
    assert.equal(optionKeyOf("sd-cpp"), "sd-cpp_backend");
    assert.equal(configKeyOf("llamacpp"), "llamacpp");
    assert.equal(optionKeyOf("llamacpp"), "llamacpp_backend");
    assert.equal(optionKeyOf("whispercpp"), "whispercpp_backend");
  });
});

describe("configuredBackend", () => {
  it("reads the engine's own block", () => {
    assert.equal(configuredBackend(CONFIG, "llamacpp"), "auto");
    assert.equal(configuredBackend(CONFIG, "whispercpp"), "cpu");
    assert.equal(configuredBackend(CONFIG, "sd-cpp"), "rocm");
  });

  it("finds no setting for an engine that has a single build", () => {
    /* The test for whether a choice is offered at all, taken from the daemon's
       own field list. Naming engines here would need a release for each new
       one Lemonade adds. */
    assert.equal(configuredBackend(CONFIG, "kokoro"), undefined);
    assert.equal(configuredBackend(CONFIG, "moonshine"), undefined);
    assert.equal(configuredBackend(CONFIG, "not-an-engine"), undefined);
  });

  it("does not treat another block as an engine", () => {
    // `telemetry` is a real block of the config and has no `backend`.
    assert.equal(configuredBackend(CONFIG, "telemetry"), undefined);
  });

  it("is not fooled by names that are not names", () => {
    for (const recipe of ["", "..", "a/b", "llamacpp\n", "__proto__", "constructor", "toString"]) {
      assert.equal(configuredBackend(CONFIG, recipe), undefined, JSON.stringify(recipe));
    }
  });

  it("ignores a backend that is not a string, or not a name", () => {
    assert.equal(configuredBackend({ llamacpp: { backend: 3 } }, "llamacpp"), undefined);
    assert.equal(configuredBackend({ llamacpp: { backend: "" } }, "llamacpp"), undefined);
    assert.equal(configuredBackend({ llamacpp: { backend: "a b" } }, "llamacpp"), undefined);
    assert.equal(configuredBackend(null, "llamacpp"), undefined);
    assert.equal(configuredBackend("nonsense", "llamacpp"), undefined);
    assert.equal(configuredBackend([], "llamacpp"), undefined);
  });
});

describe("modelChoice", () => {
  it("separates a model's own runtime from the default it would get", () => {
    const choice = modelChoice("llamacpp", parseModelOptions(LLAMA_OPTIONS), "Qwen3-0.6B-GGUF");
    assert.deepEqual(choice, { model: "Qwen3-0.6B-GGUF", own: "vulkan", fallback: "cpu" });
  });

  it("says a model that chose nothing follows the default", () => {
    const options = parseModelOptions({ ...LLAMA_OPTIONS, saved: { ctx_size: 8192 } });
    const choice = modelChoice("llamacpp", options, "m");
    assert.equal(choice?.own, undefined);
    assert.equal(choice?.fallback, "cpu");
  });

  it("does not mistake a saved context window for a saved runtime", () => {
    const options = parseModelOptions({ ...LLAMA_OPTIONS, saved: { ctx_size: 8192 } });
    assert.equal(modelChoice("llamacpp", options, "m")?.own, undefined);
  });

  it("reads the image engine's hyphenated field", () => {
    const options = parseModelOptions({
      model_name: "SD-Turbo",
      recipe: "sd-cpp",
      defaults: { steps: 4, "sd-cpp_backend": "vulkan", sdcpp_args: "" },
      saved: { "sd-cpp_backend": "cpu" },
      effective: {},
    });
    assert.deepEqual(modelChoice("sd-cpp", options, "SD-Turbo"), {
      model: "SD-Turbo", own: "cpu", fallback: "vulkan",
    });
  });

  it("finds nothing for a model whose options have no such field", () => {
    /* A write to it would be refused (`Unknown option`), so counting it as
       "follows the default" would promise a reset that cannot happen. */
    const options = parseModelOptions({
      model_name: "kokoro-v1", recipe: "kokoro", defaults: { kokoro_args: "" }, saved: {}, effective: {},
    });
    assert.equal(modelChoice("kokoro", options, "kokoro-v1"), undefined);
  });

  it("ignores a saved value that is not a runtime name", () => {
    const options = parseModelOptions({ ...LLAMA_OPTIONS, saved: { llamacpp_backend: "" } });
    assert.equal(modelChoice("llamacpp", options, "m")?.own, undefined);
  });
});

describe("engineBackendState", () => {
  const choices = [
    { model: "a", own: "vulkan", fallback: "rocm" },
    { model: "b", fallback: "rocm" },
    { model: "c", own: "cpu", fallback: "rocm" },
  ];

  it("counts the models read and names those that chose for themselves", () => {
    const state = engineBackendState({ recipe: "llamacpp", configured: "rocm", choices, loaded: ["b"] });
    assert.equal(state.models, 3);
    assert.deepEqual(state.chose, [
      { model: "a", backend: "vulkan" },
      { model: "c", backend: "cpu" },
    ]);
    assert.deepEqual(state.loaded, ["b"]);
  });

  it("takes what Automatic resolves to from the models, not from a guess", () => {
    const auto = engineBackendState({ recipe: "llamacpp", configured: AUTO, choices });
    assert.equal(auto.resolved, "rocm");
  });

  it("has no resolved runtime when no model could be asked", () => {
    const state = engineBackendState({ recipe: "llamacpp", configured: AUTO, choices: [] });
    assert.equal(state.resolved, undefined);
    assert.equal(state.models, 0);
    assert.deepEqual(state.chose, []);
  });

  it("does not hand out the caller's array", () => {
    const loaded = ["a"];
    const state = engineBackendState({ recipe: "llamacpp", configured: AUTO, choices: [], loaded });
    loaded.push("b");
    assert.deepEqual(state.loaded, ["a"]);
  });
});

describe("saying what models chose", () => {
  const chose = [
    { backend: "vulkan" }, { backend: "cpu" }, { backend: "vulkan" }, { backend: "rocm" },
  ];

  it("puts the most common first and breaks ties by name", () => {
    assert.deepEqual(tallyChosen(chose), [
      { backend: "vulkan", count: 2 },
      { backend: "cpu", count: 1 },
      { backend: "rocm", count: 1 },
    ]);
  });

  it("writes the tally in the words of the labels", () => {
    assert.equal(describeChosen(chose), "Vulkan ×2, Processor, AMD (ROCm)");
  });

  it("falls back to the id for a runtime it has no word for", () => {
    assert.equal(backendLabel("rocm"), "AMD (ROCm)");
    assert.equal(backendLabel("someday"), "someday");
  });
});

describe("the dropdown's choices", () => {
  it("offers Automatic and what is installed, and names what Automatic is", () => {
    const choices = defaultChoices({ installed: ["vulkan", "rocm"], configured: AUTO, resolved: "vulkan" });
    assert.deepEqual(choices, [
      { value: "auto", label: "Automatic (Vulkan)" },
      { value: "vulkan", label: "Vulkan" },
      { value: "rocm", label: "AMD (ROCm)" },
    ]);
  });

  it("says plain Automatic when it is not known what that is here", () => {
    const [first] = defaultChoices({ installed: ["vulkan", "rocm"], configured: AUTO });
    assert.equal(first?.label, "Automatic");
  });

  it("does not claim Automatic resolves to something once a runtime is chosen", () => {
    /* `resolved` then just repeats the choice, and "Automatic (AMD (ROCm))"
       beside a selected ROCm would read as though the two were the same act. */
    const [first] = defaultChoices({ installed: ["vulkan", "rocm"], configured: "rocm", resolved: "rocm" });
    assert.equal(first?.label, "Automatic");
  });

  it("keeps a configured runtime that is no longer installed, and says so", () => {
    /* A dropdown that showed Automatic over a config naming ROCm would be a
       false report of the machine. */
    const choices = defaultChoices({ installed: ["vulkan", "cpu"], configured: "rocm" });
    assert.deepEqual(choices.at(-1), { value: "rocm", label: "AMD (ROCm) (not installed)" });
  });

  it("does not list a runtime twice", () => {
    const choices = defaultChoices({ installed: ["vulkan", "rocm"], configured: "rocm" });
    assert.equal(choices.filter((c) => c.value === "rocm").length, 1);
  });
});

describe("which runtimes are on the machine", () => {
  it("counts an installed build that has a newer one waiting", () => {
    /* `update_required` is still installed -- the cards draw it with a tick -- and
       leaving it out would make the dropdown lose a runtime the moment Lemonade
       shipped a newer build of it. */
    const engine = {
      id: "llamacpp",
      backends: [
        { id: "vulkan", state: "installed" },
        { id: "rocm", state: "update_required" },
        { id: "cpu", state: "installable" },
        { id: "cuda", state: "unsupported" },
      ],
    };
    assert.deepEqual(installedRuntimes(engine), ["vulkan", "rocm"]);
  });

  it("is empty for an engine the daemon did not list", () => {
    assert.deepEqual(installedRuntimes(undefined), []);
  });
});

describe("refusing a default nothing could start on", () => {
  it("lets Automatic through whatever is installed", () => {
    assert.equal(assertChoosable(AUTO, []), AUTO);
  });

  it("lets an installed runtime through", () => {
    assert.equal(assertChoosable("rocm", ["vulkan", "rocm"]), "rocm");
  });

  it("refuses one that is not installed, by its own name", () => {
    /* The daemon would accept it -- it checks the hardware, not the install --
       and fetch the runtime silently at the next load. */
    assert.throws(() => assertChoosable("rocm", ["vulkan"]), /AMD \(ROCm\) is not installed/);
  });

  it("refuses something that is not a runtime name at all", () => {
    assert.throws(() => assertChoosable("rocm\"}", ["rocm\"}"]), /not installed/);
    assert.throws(() => assertChoosable("", [""]), /not installed/);
  });
});

describe("the line said after a change", () => {
  it("says what models now start on, who kept their own, and what is still running", () => {
    const text = changeNotice({
      kind: "default", now: "AMD (ROCm)", keepers: 2, loaded: ["Qwen3-8B"],
    });
    assert.match(text, /start on AMD \(ROCm\)/);
    assert.match(text, /2 models have runtimes of their own and keep them/);
    assert.match(text, /Qwen3-8B is loaded and keeps the runtime it started on until it is reloaded/);
  });

  it("is quiet about keepers when nobody kept anything", () => {
    const text = changeNotice({ kind: "default", now: "Vulkan", keepers: 0, loaded: [] });
    assert.doesNotMatch(text, /keep/);
    assert.doesNotMatch(text, /loaded/);
  });

  it("counts a reset, singular and plural", () => {
    assert.match(changeNotice({ kind: "reset", now: "Vulkan", cleared: 1, loaded: [] }), /^1 model now follows the default \(Vulkan\)/);
    assert.match(changeNotice({ kind: "reset", now: "Vulkan", cleared: 4, loaded: [] }), /^4 models now follow the default \(Vulkan\)/);
  });

  it("agrees with itself when several loaded models keep their runtime", () => {
    const text = changeNotice({ kind: "default", now: "Vulkan", loaded: ["A", "B"] });
    assert.match(text, /A, B are loaded and keep the runtimes they started on until they are reloaded/);
  });

  it("speaks of one keeper in the singular", () => {
    const text = changeNotice({ kind: "default", now: "Vulkan", keepers: 1, loaded: [] });
    assert.match(text, /1 model has a runtime of its own and keeps it/);
  });

  it("says plainly when a reset had nothing to do", () => {
    assert.match(
      changeNotice({ kind: "reset", now: "Vulkan", cleared: 0, loaded: [] }),
      /No model had a runtime of its own/,
    );
  });

  it("reports the ones that could not be changed instead of rounding to success", () => {
    const text = changeNotice({ kind: "reset", now: "Vulkan", cleared: 3, failed: 1, loaded: [] });
    assert.match(text, /3 models now follow the default/);
    assert.match(text, /1 model could not be changed/);
  });
});

describe("the sentences around the reset button", () => {
  it("names the runtimes being given up, and agrees with its count", () => {
    const three = [{ backend: "vulkan" }, { backend: "vulkan" }, { backend: "cpu" }];
    assert.equal(
      chosenSentence(three, 12),
      "3 of 12 models use a runtime of their own: Vulkan ×2, Processor.",
    );
    assert.equal(
      chosenSentence([{ backend: "vulkan" }], 12),
      "1 of 12 models uses a runtime of its own: Vulkan.",
    );
  });

  it("does not say '1 of 1' about a lone model", () => {
    assert.equal(
      chosenSentence([{ backend: "cpu" }], 1),
      "This model uses a runtime of its own: Processor.",
    );
  });

  it("puts the target on the button, so nobody has to work it out from the dropdown", () => {
    assert.equal(resetLabel(3, "AMD (ROCm)"), "Reset all 3 to AMD (ROCm)");
    assert.equal(resetLabel(1, "Automatic (Vulkan)"), "Reset it to Automatic (Vulkan)");
  });

  it("says who follows the default when nobody chose, and nothing for an empty engine", () => {
    assert.equal(followSentence(12), "All 12 models follow it.");
    assert.equal(followSentence(1), "The one model here follows it.");
    assert.equal(followSentence(0), undefined);
  });
});
