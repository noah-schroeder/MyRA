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

export class LemonadeApiError extends Error {}

export interface ApiTarget {
  /** The management base, e.g. `http://127.0.0.1:13305/api/v1`. */
  base: string;
  headers: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

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

  /** Download a model; `checkpoint` is only needed for one not already known. */
  async pullModel(modelName: string, checkpoint?: string, recipe = "llamacpp"): Promise<void> {
    await this.#post("/pull", {
      model_name: modelName,
      ...(checkpoint ? { checkpoint, recipe } : {}),
    }, 24 * 60 * 60_000);
  }

  async loadModel(modelName: string): Promise<void> {
    await this.#post("/load", { model_name: modelName }, 30 * 60_000);
  }

  async unloadModel(): Promise<void> {
    await this.#post("/unload", {});
  }

  async listModels(): Promise<{ id: string; downloaded?: boolean }[]> {
    const body = await this.#call<{ data?: { id?: string; downloaded?: boolean }[] }>("/models");
    return (body.data ?? [])
      .filter((m): m is { id: string; downloaded?: boolean } => typeof m.id === "string");
  }
}
