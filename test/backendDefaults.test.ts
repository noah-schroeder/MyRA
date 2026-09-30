/**
 * Changing the runtime models start on, and resetting the ones that chose.
 *
 * The fake below behaves the way lemond 11.8.0 was measured to: a POST to a
 * model's options merges into what it has saved, and a `null` removes that one
 * key and leaves the rest. That last part is what makes "reset the runtime"
 * safe to offer as its own button -- `DELETE` would take the context window and
 * the extra arguments with it -- so the tests that matter most here are the
 * ones that set a `ctx_size` beside the runtime and check it is still there.
 *
 * The second half runs the real client against a local server, because the
 * most likely mistake is an address: `/internal/set` answers 200 at the server
 * root and 404 under `/api/v1`, and nothing else in the suite would notice.
 */

import { strict as assert } from "node:assert";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { optionKeyOf } from "../src/core/runtime/backendDefault.ts";
import { parseModelOptions, type ModelOptions } from "../src/core/runtime/modelOptions.ts";
import {
  readBackendDefaults, resetModelBackends, setDefaultBackend, type BackendApi,
} from "../src/main/runtime/backendDefaults.ts";
import { LemonadeApi, LemonadeApiError, type InstalledModel } from "../src/main/runtime/lemonadeApi.ts";

const CONFIG = {
  llamacpp: { backend: "auto" },
  whispercpp: { backend: "auto" },
  sdcpp: { backend: "auto" },
  kokoro: { cpu_bin: "builtin" },
};

interface Daemon {
  api: BackendApi;
  saved: Record<string, Record<string, unknown>>;
  writes: { model: string; patch: Record<string, unknown> }[];
  engineWrites: { recipe: string; backend: string }[];
  /** The most models the test ever had in flight at once. */
  peak: () => number;
}

function fakeDaemon(init: {
  config?: unknown;
  models: InstalledModel[];
  saved?: Record<string, Record<string, unknown>>;
  /** What Automatic resolves to, per recipe. */
  resolved?: Record<string, string>;
  /** Models whose options cannot be read. */
  unreadable?: string[];
  /** Models whose write fails. */
  failing?: string[];
  /** Models that keep the key however they are told to drop it. */
  stubborn?: string[];
}): Daemon {
  const saved: Record<string, Record<string, unknown>> = structuredClone(init.saved ?? {});
  const writes: Daemon["writes"] = [];
  const engineWrites: Daemon["engineWrites"] = [];
  let inFlight = 0;
  let peak = 0;
  const recipeOf = (id: string): string => init.models.find((m) => m.id === id)?.recipe ?? "llamacpp";

  const optionsFor = (id: string): ModelOptions => {
    const recipe = recipeOf(id);
    const mine = saved[id] ?? {};
    const defaults = { [optionKeyOf(recipe)]: init.resolved?.[recipe] ?? "vulkan", model_name: id };
    return parseModelOptions({
      model_name: id, recipe, defaults, saved: mine, effective: { ...defaults, ...mine },
    });
  };

  const api: BackendApi = {
    config: async () => init.config ?? CONFIG,
    listModels: async () => init.models,
    modelOptions: async (id) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight -= 1;
      if (init.unreadable?.includes(id)) throw new Error("could not read");
      return optionsFor(id);
    },
    setModelOptions: async (id, patch) => {
      writes.push({ model: id, patch });
      if (init.failing?.includes(id)) throw new LemonadeApiError("/models/x/options failed (500)");
      const mine = (saved[id] ??= {});
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
          if (!init.stubborn?.includes(id)) delete mine[key];
        } else {
          mine[key] = value;
        }
      }
      return optionsFor(id);
    },
    setEngineBackend: async (recipe, backend) => {
      engineWrites.push({ recipe, backend });
    },
  };
  return { api, saved, writes, engineWrites, peak: () => peak };
}

const chat = (id: string, extra: Partial<InstalledModel> = {}): InstalledModel => ({
  id, recipe: "llamacpp", downloaded: true, ...extra,
});

describe("reading the default and who overrides it", () => {
  it("reads only the engines asked about, and only their downloaded models", async () => {
    const d = fakeDaemon({
      models: [
        chat("a"), chat("b"), chat("not-here", { downloaded: false }),
        { id: "w", recipe: "whispercpp", downloaded: true },
      ],
      saved: { a: { llamacpp_backend: "cpu" } },
    });
    const states = await readBackendDefaults(d.api, ["llamacpp"]);
    assert.deepEqual(Object.keys(states), ["llamacpp"]);
    assert.equal(states["llamacpp"]?.models, 2);
    assert.deepEqual(states["llamacpp"]?.chose, [{ model: "a", backend: "cpu" }]);
  });

  it("reports what Automatic is on this machine, from the models", async () => {
    const d = fakeDaemon({ models: [chat("a")], resolved: { llamacpp: "rocm" } });
    const states = await readBackendDefaults(d.api, ["llamacpp"]);
    assert.equal(states["llamacpp"]?.configured, "auto");
    assert.equal(states["llamacpp"]?.resolved, "rocm");
  });

  it("reports the configured runtime when the daemon's config names one", async () => {
    const d = fakeDaemon({ models: [chat("a")], config: { llamacpp: { backend: "rocm" } } });
    assert.equal((await readBackendDefaults(d.api, ["llamacpp"]))["llamacpp"]?.configured, "rocm");
  });

  it("leaves out an engine with no runtime setting instead of failing the lot", async () => {
    const d = fakeDaemon({ models: [chat("a"), { id: "k", recipe: "kokoro", downloaded: true }] });
    const states = await readBackendDefaults(d.api, ["kokoro", "llamacpp"]);
    assert.deepEqual(Object.keys(states), ["llamacpp"]);
  });

  it("answers for the models it could read when one cannot be read", async () => {
    const d = fakeDaemon({ models: [chat("a"), chat("broken"), chat("c")], unreadable: ["broken"] });
    assert.equal((await readBackendDefaults(d.api, ["llamacpp"]))["llamacpp"]?.models, 2);
  });

  it("passes on which of the engine's models are in memory", async () => {
    const d = fakeDaemon({ models: [chat("a")] });
    const states = await readBackendDefaults(d.api, ["llamacpp"], { llamacpp: ["a"], whispercpp: ["w"] });
    assert.deepEqual(states["llamacpp"]?.loaded, ["a"]);
  });

  it("does not put sixty reads in flight at once", async () => {
    const d = fakeDaemon({ models: Array.from({ length: 60 }, (_, i) => chat(`m${i}`)) });
    const states = await readBackendDefaults(d.api, ["llamacpp"]);
    assert.equal(states["llamacpp"]?.models, 60);
    assert.ok(d.peak() <= 6, `peak was ${d.peak()}`);
  });
});

describe("choosing the default", () => {
  it("writes an installed runtime", async () => {
    const d = fakeDaemon({ models: [] });
    await setDefaultBackend(d.api, "llamacpp", "rocm", ["vulkan", "rocm"]);
    assert.deepEqual(d.engineWrites, [{ recipe: "llamacpp", backend: "rocm" }]);
  });

  it("hands the choice back to Lemonade on request", async () => {
    const d = fakeDaemon({ models: [] });
    await setDefaultBackend(d.api, "llamacpp", "auto", ["vulkan", "rocm"]);
    assert.deepEqual(d.engineWrites, [{ recipe: "llamacpp", backend: "auto" }]);
  });

  it("refuses a runtime that is not installed, and writes nothing", async () => {
    const d = fakeDaemon({ models: [] });
    await assert.rejects(setDefaultBackend(d.api, "llamacpp", "rocm", ["vulkan"]), /not installed/);
    assert.deepEqual(d.engineWrites, []);
  });

  it("refuses an engine the daemon has no runtime setting for, and writes nothing", async () => {
    /* The recipe becomes a key in a request body. Being in the daemon's own
       config with a `backend` is what makes it a key worth writing. */
    const d = fakeDaemon({ models: [] });
    await assert.rejects(setDefaultBackend(d.api, "kokoro", "cpu", ["cpu"]), /no runtime setting/);
    await assert.rejects(setDefaultBackend(d.api, "telemetry", "cpu", ["cpu"]), /no runtime setting/);
    await assert.rejects(setDefaultBackend(d.api, "../x", "cpu", ["cpu"]), /no runtime setting/);
    assert.deepEqual(d.engineWrites, []);
  });
});

describe("resetting every model to the default", () => {
  it("removes the runtime and keeps everything else the model had saved", async () => {
    const d = fakeDaemon({
      models: [chat("a")],
      saved: { a: { llamacpp_backend: "vulkan", ctx_size: 16384, llamacpp_args: "--flash-attn on" } },
    });
    const result = await resetModelBackends(d.api, "llamacpp");
    assert.deepEqual(result.cleared, ["a"]);
    assert.deepEqual(d.saved["a"], { ctx_size: 16384, llamacpp_args: "--flash-attn on" });
  });

  it("sends a patch of the one key, never a reset of the whole model", async () => {
    const d = fakeDaemon({ models: [chat("a")], saved: { a: { llamacpp_backend: "cpu" } } });
    await resetModelBackends(d.api, "llamacpp");
    assert.deepEqual(d.writes, [{ model: "a", patch: { llamacpp_backend: null } }]);
  });

  it("leaves alone a model that never chose, without writing to it", async () => {
    const d = fakeDaemon({
      models: [chat("chose"), chat("follows"), chat("only-ctx")],
      saved: { chose: { llamacpp_backend: "cpu" }, "only-ctx": { ctx_size: 4096 } },
    });
    const result = await resetModelBackends(d.api, "llamacpp");
    assert.deepEqual(result.cleared, ["chose"]);
    assert.deepEqual(d.writes.map((w) => w.model), ["chose"]);
    assert.deepEqual(d.saved["only-ctx"], { ctx_size: 4096 });
  });

  it("does not touch another engine's models", async () => {
    const d = fakeDaemon({
      models: [chat("a"), { id: "w", recipe: "whispercpp", downloaded: true }],
      saved: { a: { llamacpp_backend: "cpu" }, w: { whispercpp_backend: "cpu" } },
    });
    await resetModelBackends(d.api, "llamacpp");
    assert.deepEqual(d.saved["w"], { whispercpp_backend: "cpu" });
  });

  it("uses the image engine's hyphenated field", async () => {
    const d = fakeDaemon({
      models: [{ id: "sd", recipe: "sd-cpp", downloaded: true }],
      saved: { sd: { "sd-cpp_backend": "cpu", steps: 8 } },
      config: { sdcpp: { backend: "auto" } },
    });
    const result = await resetModelBackends(d.api, "sd-cpp");
    assert.deepEqual(result.cleared, ["sd"]);
    assert.deepEqual(d.saved["sd"], { steps: 8 });
  });

  it("carries on past a model that fails and says which", async () => {
    const d = fakeDaemon({
      models: [chat("a"), chat("bad"), chat("c")],
      saved: {
        a: { llamacpp_backend: "cpu" }, bad: { llamacpp_backend: "cpu" }, c: { llamacpp_backend: "cpu" },
      },
      failing: ["bad"],
    });
    const result = await resetModelBackends(d.api, "llamacpp");
    assert.deepEqual(result.cleared, ["a", "c"]);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0]?.model, "bad");
  });

  it("does not call it cleared when the daemon still holds the key", async () => {
    /* A 200 is not the proof; the options in the answer are. */
    const d = fakeDaemon({
      models: [chat("a")], saved: { a: { llamacpp_backend: "cpu" } }, stubborn: ["a"],
    });
    const result = await resetModelBackends(d.api, "llamacpp");
    assert.deepEqual(result.cleared, []);
    assert.equal(result.failed[0]?.model, "a");
  });

  it("refuses an engine with no runtime setting before it touches anything", async () => {
    const d = fakeDaemon({
      models: [{ id: "k", recipe: "kokoro", downloaded: true }],
      saved: { k: { kokoro_backend: "cpu" } },
    });
    await assert.rejects(resetModelBackends(d.api, "kokoro"), /no runtime setting/);
    assert.deepEqual(d.writes, []);
  });

  it("has nothing to do when no model chose, and says so by clearing none", async () => {
    const d = fakeDaemon({ models: [chat("a"), chat("b")] });
    const result = await resetModelBackends(d.api, "llamacpp");
    assert.deepEqual(result, { cleared: [], failed: [] });
    assert.deepEqual(d.writes, []);
  });
});

/* -------------------------------------------- the client, at the address -- */

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: string;
}

/** A server that records what it was asked and answers with `reply`. */
async function withServer<T>(
  reply: (seen: Seen) => { status?: number; body: unknown },
  run: (api: LemonadeApi, seen: Seen[]) => Promise<T>,
): Promise<T> {
  const seen: Seen[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const entry: Seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        auth: req.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(entry);
      const r = reply(entry);
      res.writeHead(r.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const api = new LemonadeApi(() => ({
      base: `http://127.0.0.1:${port}/api/v1`,
      headers: { authorization: "Bearer probe" },
    }));
    return await run(api, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("the client reaches the daemon's internal routes at the server root", () => {
  it("reads the config from /internal/config, with the key", async () => {
    await withServer(() => ({ body: CONFIG }), async (api, seen) => {
      assert.deepEqual(await api.config(), CONFIG);
      assert.equal(seen[0]?.method, "GET");
      assert.equal(seen[0]?.url, "/internal/config");
      assert.equal(seen[0]?.auth, "Bearer probe");
    });
  });

  it("writes one field, to /internal/set, in the shape the daemon's own CLI sends", async () => {
    await withServer(() => ({ body: { status: "success" } }), async (api, seen) => {
      await api.setEngineBackend("llamacpp", "rocm");
      assert.equal(seen[0]?.method, "POST");
      assert.equal(seen[0]?.url, "/internal/set");
      assert.deepEqual(JSON.parse(seen[0]?.body ?? ""), { llamacpp: { backend: "rocm" } });
    });
  });

  it("writes the image engine to `sdcpp`, which is the block that exists", async () => {
    await withServer(() => ({ body: {} }), async (api, seen) => {
      await api.setEngineBackend("sd-cpp", "cpu");
      assert.deepEqual(JSON.parse(seen[0]?.body ?? ""), { sdcpp: { backend: "cpu" } });
    });
  });

  it("will not build a request out of something that is not a name", async () => {
    await withServer(() => ({ body: {} }), async (api, seen) => {
      await assert.rejects(api.setEngineBackend("llamacpp", 'rocm"}'), /not a runtime name/);
      await assert.rejects(api.setEngineBackend("a b", "rocm"), /not a runtime name/);
      await assert.rejects(api.setEngineBackend("", "rocm"), /not a runtime name/);
      assert.equal(seen.length, 0);
    });
  });

  it("carries the daemon's own refusal through", async () => {
    await withServer(
      () => ({ status: 400, body: { error: "'llamacpp.backend' must be one of: auto, vulkan, cpu" } }),
      async (api) => {
        await assert.rejects(
          api.setEngineBackend("llamacpp", "rocm"),
          /must be one of: auto, vulkan, cpu/,
        );
      },
    );
  });
});
