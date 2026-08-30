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
import {
  parseSearch,
  parseVariants,
  type RegistrySource,
  type RepoVariants,
  type SearchResult,
} from "../../core/runtime/registry.ts";

export class LemonadeApiError extends Error {}

export interface ApiTarget {
  /** The management base, e.g. `http://127.0.0.1:13305/api/v1`. */
  base: string;
  headers: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export interface InstalledModel {
  id: string;
  downloaded?: boolean;
  /** Converted from the catalogue's gigabytes. */
  sizeBytes?: number;
  /** `extra_models_dir` for anything found rather than downloaded. */
  source?: string;
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
    let res: Response;
    try {
      res = await fetch(`${target.base}${path}`, {
        ...init,
        headers: { ...target.headers, ...(init.headers as Record<string, string>) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new LemonadeApiError(`could not reach Lemonade: ${(err as Error).message}`);
    }
    if (!res.ok) {
      /* The body usually says more than the status does, and truncating it
         keeps a stack trace out of a message meant for a person. */
      const detail = (await res.text().catch(() => "")).trim().slice(0, 300);
      throw new LemonadeApiError(`${path} failed (${res.status})${detail ? `: ${detail}` : ""}`);
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

  async downloads(): Promise<DownloadJob[]> {
    return parseDownloads(await this.#call<unknown>("/downloads", {}, 10_000));
  }

  /** Register a model without downloading it, for files already on disk. */
  async registerModel(modelName: string, checkpoint: string, recipe = "llamacpp"): Promise<void> {
    await this.#post("/models/register", { model_name: modelName, checkpoint, recipe });
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
  async searchRegistry(query: string, source: RegistrySource, limit = 50): Promise<SearchResult> {
    const params = new URLSearchParams({ query, source, limit: String(limit) });
    return parseSearch(await this.#call<unknown>(`/registry/search?${params.toString()}`, {}, 20_000), source);
  }

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
  async pullModel(
    modelName: string,
    checkpoint?: string,
    recipe = "llamacpp",
    source?: RegistrySource,
  ): Promise<void> {
    await this.#post("/pull", {
      model_name: modelName,
      ...(checkpoint ? { checkpoint, recipe } : {}),
      /* Named explicitly for the same reason as `repoVariants`: without it a
         download chosen from the ModelScope list can arrive from Hugging Face,
         which is the one outcome this whole feature exists to prevent. */
      ...(source ? { source } : {}),
    }, 24 * 60 * 60_000);
  }

  async loadModel(modelName: string): Promise<void> {
    await this.#post("/load", { model_name: modelName }, 30 * 60_000);
  }

  async unloadModel(): Promise<void> {
    await this.#post("/unload", {});
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
    type Raw = { id?: string; downloaded?: boolean; size?: number; source?: string; labels?: string[] };
    const body = await this.#call<{ data?: Raw[] }>("/models");
    return (body.data ?? [])
      .filter((m): m is Raw & { id: string } => typeof m.id === "string")
      .map((m) => ({
        id: m.id,
        ...(m.downloaded !== undefined ? { downloaded: m.downloaded } : {}),
        ...(typeof m.size === "number" && m.size > 0
          ? { sizeBytes: Math.round(m.size * 1024 ** 3) }
          : {}),
        ...(m.source ? { source: m.source } : {}),
      }));
  }
}
