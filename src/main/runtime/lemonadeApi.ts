/**
 * Talking to the Lemonade daemon.
 *
 * A thin client rather than a layer of abstraction: the daemon's API is the
 * interface, and wrapping it in Karen's own vocabulary would mean maintaining a
 * translation for no benefit. What lives here is what a client genuinely owes
 * the caller -- authentication, a deadline, and an error that names what failed
 * rather than surfacing a bare status code.
 *
 * Request shapes are upstream's, taken from its API documentation.
 */

import { parseDownloads, parseSystemInfo, type DownloadJob, type MachineInfo } from "../../core/runtime/systemInfo.ts";
import type { PullProgress } from "../../core/runtime/systemInfo.ts";
import { parseModelOptions, type ModelOptions } from "../../core/runtime/modelOptions.ts";
import {
  parseVariants,
  type RegistrySource,
  type RepoVariants,
} from "../../core/runtime/registry.ts";

export class LemonadeApiError extends Error {}

/** `/install/dry-run`: where a backend's binaries would come from. */
export interface DryRun {
  recipe: string;
  backend: string;
  /** The GitHub repository publishing this engine, e.g. `ggml-org/llama.cpp`. */
  repo: string;
  /** The pinned version, which is not necessarily the installed one. */
  version: string;
  /** The exact asset name, which a tag alone does not determine. */
  filename: string;
  url: string;
  supported: boolean;
}

function parseDryRun(raw: unknown): DryRun {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (key: string): string => (typeof r[key] === "string" ? (r[key] as string) : "");
  return {
    recipe: text("recipe"),
    backend: text("backend"),
    repo: text("repo"),
    version: text("version"),
    filename: text("filename"),
    url: text("url"),
    supported: r["supported"] === true,
  };
}

export interface ApiTarget {
  /** The management base, e.g. `http://127.0.0.1:13305/api/v1`. */
  base: string;
  headers: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * How the daemon says "that one is yours to delete, not mine".
 *
 * Matched on rather than parsed: the message continues with the path, which is
 * the useful part and is read separately.
 */
export const EXTRA_MODEL_REFUSAL = "Cannot delete extra models via API";

export interface InstalledModel {
  id: string;
  /**
   * What the model is FOR: `chat`, `transcription`, `tts`, `embedding`…
   *
   * Read but discarded until audio needed it, which was a quiet loss: without
   * labels the only way to tell a speech model from a chat one is its name, and
   * Karen did exactly that -- `/whisper|moonshine/i` -- which is a guess that
   * misses a renamed checkpoint and would mistake a `whisper-tts` voice model
   * for a transcriber.
   */
  labels?: string[];
  downloaded?: boolean;
  /** Converted from the catalogue's gigabytes. */
  sizeBytes?: number;
  /** `extra_models_dir` for anything found rather than downloaded. */
  source?: string;
  /**
   * Where it came from: `org/repo:file.gguf`, or an absolute path.
   *
   * The only thing tying an installed model back to a repository, which is what
   * lets "My models" open the same card as the other two tabs. A local file has
   * no repository, and `repoOf` says so rather than inventing one.
   */
  checkpoint?: string;
  /** The engine that runs it, needed to describe the repository correctly. */
  recipe?: string;
}

export class LemonadeApi {
  #target: () => ApiTarget | undefined;

  constructor(target: () => ApiTarget | undefined) {
    this.#target = target;
  }

  get available(): boolean {
    return Boolean(this.#target());
  }

  async #call<T>(path: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const target = this.#target();
    if (!target) throw new LemonadeApiError("Lemonade is not running.");
    return this.#send<T>(`${target.base}${path}`, path, target.headers, init, timeoutMs);
  }

  /**
   * The daemon's Ollama-compatible routes, which sit beside `/api/v1` and not
   * under it.
   *
   * `lemond` registers `/api/chat`, `/api/tags`, `/api/pull` and `/api/delete`
   * as well as its own API, and deleting a model exists only there --
   * `DELETE /api/v1/models/{id}` is a 404, measured. So one call in this file
   * addresses a different base, and it does it by trimming the version off the
   * one target rather than by holding a second address that could drift.
   */
  async #callOllama<T>(path: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const target = this.#target();
    if (!target) throw new LemonadeApiError("Lemonade is not running.");
    return this.#send<T>(
      `${target.base.replace(/\/v\d+$/, "")}${path}`, `/api${path}`, target.headers, init, timeoutMs,
    );
  }

  async #send<T>(
    url: string,
    label: string,
    auth: Record<string, string>,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: { ...auth, ...(init.headers as Record<string, string>) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new LemonadeApiError(`could not reach Lemonade: ${(err as Error).message}`);
    }
    if (!res.ok) {
      /* The body usually says more than the status does, and truncating it
         keeps a stack trace out of a message meant for a person. */
      const detail = (await res.text().catch(() => "")).trim().slice(0, 300);
      throw new LemonadeApiError(`${label} failed (${res.status})${detail ? `: ${detail}` : ""}`);
    }
    return (await res.json().catch(() => ({}))) as T;
  }

  async #post<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
    return this.#call<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, timeoutMs);
  }

  /** Everything about the machine: devices, memory, and every backend's state. */
  async systemInfo(): Promise<MachineInfo> {
    return parseSystemInfo(await this.#call<unknown>("/system-info"));
  }

  /** The same, unparsed, for the runtime pane's raw view. */
  async systemInfoRaw(): Promise<unknown> {
    return this.#call<unknown>("/system-info");
  }

  /**
   * Install a backend, e.g. `llamacpp` + `cuda`.
   *
   * A long call -- this is where a 600 MB CUDA build is fetched -- so it gets a
   * deadline measured in tens of minutes rather than the default. Progress is
   * not in the response; it is polled from `downloads()`.
   */
  async installBackend(recipe: string, backend: string): Promise<void> {
    await this.#post("/install", { recipe, backend }, 60 * 60_000);
  }

  /**
   * What an install of this backend would fetch, without fetching it.
   *
   * The only place Karen learns which repository publishes an engine, and it
   * has to be asked rather than tabulated: llama.cpp's Vulkan build comes from
   * `ggml-org/llama.cpp` and its CUDA build from the `lemonade-sdk/llama.cpp`
   * fork, whisper's from `lemonade-sdk/whisper.cpp-rocm` despite the name, and
   * a second copy of that mapping in Karen would be wrong the first time
   * upstream moved one.
   *
   * `version` is the pin, so this answers "what would happen now" rather than
   * "what is installed" -- the two differ exactly when an update is waiting.
   * A `version` in the request is ignored by the daemon; the pin is read from
   * its resources at startup and nothing else changes it.
   *
   * 500 on a machine with no compatible device, carrying a genuinely good
   * sentence about which cards the backend needs, so the caller should keep
   * the message rather than replace it.
   */
  async installDryRun(recipe: string, backend: string): Promise<DryRun> {
    return parseDryRun(await this.#post<unknown>("/install/dry-run", { recipe, backend }, 30_000));
  }

  async downloads(): Promise<DownloadJob[]> {
    return parseDownloads(await this.#call<unknown>("/downloads", {}, 10_000));
  }

  /** Register a model without downloading it, for files already on disk. */
  async registerModel(modelName: string, checkpoint: string, recipe = "llamacpp"): Promise<void> {
    await this.#post("/models/register", { model_name: modelName, checkpoint, recipe });
  }

  /**
   * Remove a model the daemon downloaded, files and registration together.
   *
   * Measured against lemond 11.8.0, because none of it is guessable from the
   * documentation:
   *
   *   - the route is `DELETE /api/delete` with `{"name": …}`, borrowed from
   *     Ollama. `DELETE /api/v1/models/{id}` answers 404 -- the `.../models/(.+)`
   *     route it looks like it should hit is the per-model *options* handler;
   *   - a name it does not know is a 404 naming it back;
   *   - anything reached through `extra_models_dir` is a **500** carrying
   *     `Cannot delete extra models via API … Delete the file directly from: <path>`,
   *     which is not a failure so much as a handover. `EXTRA_MODEL_REFUSAL`
   *     below is how the caller recognises it.
   *
   * The daemon unloads a loaded model before deleting it, so no caller has to.
   */
  async deleteModel(modelName: string): Promise<void> {
    await this.#callOllama("/delete", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: modelName }),
    }, 60_000);
  }

  /**
   * Search a registry for repositories.
   *
   * `limit` is what lemonade asks the registry for, capped at 50 by the
   * daemon; what comes back is fewer, sometimes far fewer, because repository
   * types it cannot run are dropped after the fetch. Asking for the maximum is
   * therefore the right default rather than greedy.
   *
   * Given a shorter deadline than the default: ModelScope answers in about a
   * second from a European connection and Hugging Face in a fifth of that, so
   * thirty seconds of a person watching a spinner buys nothing.
   */
  /**
   * The quantisations a repository offers, with exact sizes.
   *
   * `source` must be passed even though the endpoint has a default, or a
   * ModelScope result silently resolves against Hugging Face -- measured: the
   * same `org/repo` id frequently exists on both, so the wrong one answers
   * with a plausible list rather than an error.
   */
  async repoVariants(checkpoint: string, source: RegistrySource): Promise<RepoVariants> {
    const params = new URLSearchParams({ checkpoint, source });
    return parseVariants(await this.#call<unknown>(`/pull/variants?${params.toString()}`, {}, 60_000), source);
  }

  /** Download a model; `checkpoint` is only needed for one not already known. */
  /**
   * Download a model, reporting progress as it goes.
   *
   * `stream: true` is the whole point. Without it `/pull` returns one line of
   * JSON when the transfer finishes, and a multi-gigabyte download is a button
   * that says nothing for twenty minutes. With it the daemon answers
   * `text/event-stream` and emits a `progress` event carrying
   * `bytes_downloaded`, `bytes_total`, `percent`, `file` and `file_index` --
   * everything a person needs to tell a slow connection from a stuck one.
   *
   * `/api/v1/downloads` is not the answer and was tried first: it returns an
   * empty array throughout a pull started this way, because it reports the
   * daemon's own background jobs rather than a transfer a caller is awaiting.
   */
  async pullModel(
    modelName: string,
    checkpoint?: string,
    recipe = "llamacpp",
    source?: RegistrySource,
    onProgress?: (p: PullProgress) => void,
  ): Promise<void> {
    const target = this.#target();
    if (!target) throw new LemonadeApiError("Lemonade is not running.");

    const body = {
      model_name: modelName,
      ...(checkpoint ? { checkpoint, recipe } : {}),
      /* Named explicitly for the same reason as `repoVariants`: without it a
         download chosen from the ModelScope list can arrive from Hugging Face,
         which is the one outcome this whole feature exists to prevent. */
      ...(source ? { source } : {}),
      stream: Boolean(onProgress),
    };

    let res: Response;
    try {
      res = await fetch(`${target.base}/pull`, {
        method: "POST",
        headers: { ...target.headers, "content-type": "application/json" },
        body: JSON.stringify(body),
        /* No overall timeout: a 30 GB model on a hotel connection is a
           legitimate several hours, and the stream itself is the liveness
           signal -- if it stops arriving, the fetch fails on its own. */
      });
    } catch (err) {
      throw new LemonadeApiError(`could not reach Lemonade: ${(err as Error).message}`);
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).trim().slice(0, 300);
      throw new LemonadeApiError(`/pull failed (${res.status})${detail ? `: ${detail}` : ""}`);
    }

    if (!onProgress || !res.body) {
      await res.text().catch(() => "");
      return;
    }

    await readProgressStream(res.body, onProgress);
  }

  /* ------------------------------------------------- per-model options -- */

  /**
   * The load settings for one model: defaults, overrides, and the merge.
   *
   * The daemon owns this store -- it is what launches llama-server, so a
   * setting Karen kept on its own would be a preference the launch never read.
   */
  async modelOptions(modelName: string): Promise<ModelOptions> {
    const path = `/models/${encodeURIComponent(modelName)}/options`;
    return parseModelOptions(await this.#call<unknown>(path, {}, 15_000), modelName);
  }

  /**
   * Save overrides, and return the daemon's own view of the result.
   *
   * A patch, not the whole object: posting every field would turn each default
   * into an override that survives the daemon changing its own defaults. The
   * response is parsed and returned rather than discarded, because it carries
   * the re-resolved `resolved_ctx_size` -- what auto-tune now works out -- and
   * that is the thing a person just changed and wants to see.
   */
  async setModelOptions(modelName: string, patch: Record<string, unknown>): Promise<ModelOptions> {
    const path = `/models/${encodeURIComponent(modelName)}/options`;
    return parseModelOptions(await this.#post<unknown>(path, patch, 15_000), modelName);
  }

  /** Drop every override for a model, back to the daemon's defaults. */
  async resetModelOptions(modelName: string): Promise<ModelOptions> {
    const path = `/models/${encodeURIComponent(modelName)}/options`;
    return parseModelOptions(await this.#call<unknown>(path, { method: "DELETE" }, 15_000), modelName);
  }

  async loadModel(modelName: string): Promise<void> {
    await this.#post("/load", { model_name: modelName }, 30 * 60_000);
  }

  /**
   * Let go of a model, naming it when the caller has one in mind.
   *
   * The daemon holds several at once on separate backends -- chat on one port,
   * Whisper on another -- so "unload" without a name is ambiguous in a way it
   * was not when only chat existed.
   *
   * `model_name` is the field, and the daemon does read it: asked to unload a
   * model it is not holding, lemond 11.8.0 answers
   * `404 {"error":"Model not loaded: Whisper-Base"}` -- naming the model back,
   * which it could only do by having looked that model up. Measured, because
   * the alternative was an eject button that might have taken the
   * conversation's model down with it.
   */
  async unloadModel(modelName?: string): Promise<void> {
    await this.#post("/unload", modelName ? { model_name: modelName } : {});
  }

  /**
   * Every model the daemon knows about.
   *
   * `size` arrives in gigabytes and is converted here, because every other
   * size in Karen is bytes and a unit that changes at an API boundary is a bug
   * waiting for a big number. `source` distinguishes a model the daemon
   * downloaded from one it found in the directory Karen points it at.
   */
  async listModels(): Promise<InstalledModel[]> {
    type Raw = {
      id?: string; downloaded?: boolean; size?: number; source?: string; labels?: string[];
      checkpoint?: string; recipe?: string;
    };
    const body = await this.#call<{ data?: Raw[] }>("/models");
    return (body.data ?? [])
      .filter((m): m is Raw & { id: string } => typeof m.id === "string")
      .map((m) => ({
        id: m.id,
        ...(Array.isArray(m.labels) ? { labels: m.labels.filter((l) => typeof l === "string") } : {}),
        ...(m.downloaded !== undefined ? { downloaded: m.downloaded } : {}),
        ...(typeof m.size === "number" && m.size > 0
          ? { sizeBytes: Math.round(m.size * 1024 ** 3) }
          : {}),
        ...(m.source ? { source: m.source } : {}),
        ...(typeof m.checkpoint === "string" && m.checkpoint ? { checkpoint: m.checkpoint } : {}),
        ...(typeof m.recipe === "string" && m.recipe ? { recipe: m.recipe } : {}),
      }));
  }
}



/**
 * Read the daemon's `text/event-stream` and call back on each `progress` event.
 *
 * Server-sent events are `event:` and `data:` lines separated by blank lines,
 * and a chunk boundary can fall anywhere -- including mid-number -- so the
 * buffer is carried between reads rather than each chunk being parsed alone.
 *
 * A malformed frame is skipped rather than thrown: this drives a progress bar,
 * and failing a download because one tick was unparseable would be absurd.
 */
export async function readProgressStream(
  body: ReadableStream<Uint8Array>,
  onProgress: (p: PullProgress) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Complete frames only; whatever follows the last blank line waits.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      try {
        const d = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
        const n = (k: string): number => (typeof d[k] === "number" ? (d[k] as number) : 0);
        /* `bytes_total` arrives as 0 on most ticks and only the first frame
           carries the real size, so the whole-transfer figure is preferred --
           it is the one that stays put. */
        const total = n("total_download_size") || n("bytes_total");
        onProgress({
          file: typeof d["file"] === "string" ? d["file"] : "",
          fileIndex: n("file_index"),
          totalFiles: n("total_files"),
          bytesDone: n("bytes_downloaded") + n("bytes_previously_downloaded"),
          bytesTotal: total,
          percent: n("percent"),
        });
      } catch {
        /* A frame that is not JSON is not worth failing a download over. */
      }
    }
  }
}
