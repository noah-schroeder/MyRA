/**
 * Reading Lemonade's account of the machine.
 *
 * This replaces three things Karen used to do for itself: enumerate devices by
 * running `llama-server --list-devices`, guess a backend from PCI vendor ids,
 * and explain to the user why a card it could see was not being used. Lemonade
 * answers all three in one request, and answers the third better than Karen
 * did -- every device carries an `error` string when it is unavailable, and
 * every backend a `state` and a human `message`.
 *
 * The shape is upstream's and may change, so everything here is defensive:
 * unknown keys are ignored, missing ones produce absence rather than throwing,
 * and a device Karen cannot interpret is simply not listed. A parser that threw
 * on an unexpected payload would take the whole runtime pane down with it.
 *
 * **One field is deliberately read through a list of candidate names.** The
 * daemon collects VRAM with
 * `nvidia-smi --query-gpu=index,uuid,name,compute_cap,driver_version,memory.total`
 * -- read out of the binary itself -- so the number is certainly reported, but
 * the JSON key it lands under could not be confirmed without an NVIDIA card to
 * point at. Rather than guess one name, the plausible ones are tried in turn
 * and the caller has fallbacks behind that. Worth simplifying once a machine
 * with a card has shown which it is.
 */

/** One accelerator, in Karen's existing vocabulary. */
export interface Device {
  id: string;
  description: string;
  totalBytes?: number;
  freeBytes?: number;
}

export interface BackendOption {
  /** `cuda`, `vulkan`, `rocm`, `cpu`, `metal`. */
  id: string;
  /** `installed`, `installable`, `update_required`, `unsupported`. */
  state: string;
  /** Upstream's own sentence about this backend. */
  message?: string | undefined;
  /**
   * The build in play.
   *
   * Which build depends on the state, and the difference matters: once
   * something is installed this is read from the `version.txt` beside the
   * binary, so it is what is actually on the disk. Before that it is the
   * pinned version -- what an install would fetch.
   */
  version?: string | undefined;
  /** The release page for the build this backend is heading towards. */
  releaseUrl?: string | undefined;
  /**
   * The build waiting to be installed, when one is.
   *
   * Only present on `update_required`, and read out of `release_url` because
   * that is the only field carrying the target version as a version --
   * `download_filename` carries it as part of a filename, and for
   * stable-diffusion.cpp the two are not the same string.
   */
  pendingVersion?: string | undefined;
}

/** One engine and every backend it could run on. */
export interface EngineInfo {
  id: string;
  backends: BackendOption[];
}

export interface MachineInfo {
  devices: Device[];
  /** Total system memory, when it could be read. */
  ramBytes?: number | undefined;
  /** Free bytes where models are stored. */
  modelStorageFreeBytes?: number | undefined;
  /** The llama.cpp backends, which is what chat runs on. */
  backends: BackendOption[];
  /**
   * Every engine Lemonade offers, with the state of each of its backends.
   *
   * Not only llama.cpp: speech, text-to-speech, image and the rest are separate
   * engines with their own backends and their own hardware support, and each
   * has to be installed before the models that need it will run.
   */
  engines: EngineInfo[];
  /** The NVIDIA driver version, when there is one. */
  driverVersion?: string | undefined;
  osVersion?: string | undefined;
  /** Why no accelerator is in use, in the daemon's own words. */
  note?: string | undefined;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * Where a device's memory is reported, and in what unit.
 *
 * `vram_gb` is Lemonade's own key, confirmed against the daemon rather than
 * guessed -- an earlier candidate list here missed it, and an RTX 4060 showed
 * its name with a dash where the memory should be. The unit is read from the
 * key rather than inferred from the number, because `vram_gb: 8` is 8 GB and
 * every size heuristic in the world reads a bare 8 as something else.
 *
 * The rest stay as fallbacks: this payload is not versioned, and a key that
 * disappears should degrade to "unknown", not to a wrong number.
 */
const MEMORY_KEYS: [key: string, scale: number | undefined][] = [
  ["vram_gb", 1024 ** 3],
  ["vram_mb", 1024 ** 2],
  ["memory_gb", 1024 ** 3],
  ["memory_mb", 1024 ** 2],
  ["memory_bytes", 1],
  ["memory_total_bytes", 1],
  ["total_bytes", 1],
  // No unit in the name: fall back to sniffing the value.
  ["memory_total", undefined],
  ["total_memory", undefined],
  ["memory", undefined],
  ["vram", undefined],
];

/**
 * A memory figure in bytes, whatever unit it arrived in.
 *
 * nvidia-smi's `memory.total` with `nounits` is megabytes, which is the most
 * likely form; a plain number under 10^6 is therefore read as MB and anything
 * larger as bytes already. Strings like "8192 MiB" and "15.11 GB" also occur
 * elsewhere in this payload, so they are handled too.
 */
export function toBytes(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e6 ? Math.round(value * 1024 * 1024) : Math.round(value);
  }
  const text = str(value);
  if (!text) return undefined;
  const m = /^\s*([\d.]+)\s*(TiB|GiB|MiB|KiB|TB|GB|MB|KB|B)?\s*$/i.exec(text);
  if (!m?.[1]) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = (m[2] ?? "MB").toUpperCase();
  const scale: Record<string, number> = {
    B: 1, KB: 1024, KIB: 1024, MB: 1024 ** 2, MIB: 1024 ** 2,
    GB: 1024 ** 3, GIB: 1024 ** 3, TB: 1024 ** 4, TIB: 1024 ** 4,
  };
  return Math.round(n * (scale[unit] ?? 1024 ** 2));
}

function deviceMemory(entry: Obj): number | undefined {
  for (const [key, scale] of MEMORY_KEYS) {
    if (!(key in entry)) continue;
    const raw = entry[key];
    if (scale !== undefined && typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return Math.round(raw * scale);
    }
    const bytes = toBytes(raw);
    if (bytes) return bytes;
  }
  return undefined;
}

/**
 * The accelerators worth offering, in the order llama.cpp would name them.
 *
 * Unavailable entries are dropped rather than listed as broken: the reason they
 * are unavailable belongs in the explanation, not in a device list that feeds a
 * "will this model fit" calculation.
 */
export function parseDevices(raw: unknown): Device[] {
  const devices = obj(obj(raw)["devices"]);
  const out: Device[] = [];
  const add = (entries: unknown, prefix: string): void => {
    arr(entries).forEach((value, i) => {
      const entry = obj(value);
      if (entry["available"] !== true) return;
      const name = str(entry["name"]) ?? prefix;
      const bytes = deviceMemory(entry);
      out.push({
        id: `${prefix}${i}`,
        description: name,
        ...(bytes ? { totalBytes: bytes } : {}),
      });
    });
  };
  add(devices["nvidia_gpu"], "CUDA");
  add(devices["amd_gpu"], "ROCm");
  add(devices["intel_gpu"], "Vulkan");
  return out;
}

/** Every backend Lemonade knows about for the primary engine. */
export function parseBackends(raw: unknown, recipe = "llamacpp"): BackendOption[] {
  const backends = obj(obj(obj(obj(raw)["recipes"])[recipe])["backends"]);
  return Object.entries(backends).map(([id, value]) => {
    const entry = obj(value);
    const state = str(entry["state"]) ?? "unknown";
    const releaseUrl = str(entry["release_url"]);
    const pending = state === "update_required" ? tagFromReleaseUrl(releaseUrl) : undefined;
    return {
      id,
      state,
      ...(str(entry["message"]) ? { message: str(entry["message"]) } : {}),
      ...(str(entry["version"]) ? { version: str(entry["version"]) } : {}),
      ...(releaseUrl ? { releaseUrl } : {}),
      ...(pending ? { pendingVersion: pending } : {}),
    };
  });
}

/**
 * The tag out of `https://github.com/owner/repo/releases/tag/<tag>`.
 *
 * Decoded, because a tag can contain characters GitHub escapes in a path, and
 * returned only when the URL really has that shape -- a link to something else
 * is not a version and should read as absent rather than as the last path
 * segment of whatever it was.
 */
export function tagFromReleaseUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = /\/releases\/tag\/([^/?#]+)$/.exec(url);
  if (!m?.[1]) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** Backends that could be installed and would actually work here. */
export function installableBackends(backends: BackendOption[]): BackendOption[] {
  return backends.filter((b) => b.state === "installable" || b.state === "installed");
}

/** Every engine in the payload, in a stable order. */
export function parseEngines(raw: unknown): EngineInfo[] {
  const recipes = obj(obj(raw)["recipes"]);
  return Object.keys(recipes)
    .sort()
    .map((id) => ({ id, backends: parseBackends(raw, id) }))
    .filter((e) => e.backends.length);
}

export function parseSystemInfo(raw: unknown): MachineInfo {
  const root = obj(raw);
  const devices = obj(root["devices"]);
  const nvidia = obj(arr(devices["nvidia_gpu"])[0]);
  const storage = obj(root["model_storage"]);
  const free = storage["free_bytes"];
  return {
    devices: parseDevices(raw),
    backends: parseBackends(raw),
    engines: parseEngines(raw),
    ...(toBytes(root["Physical Memory"]) ? { ramBytes: toBytes(root["Physical Memory"]) } : {}),
    ...(typeof free === "number" ? { modelStorageFreeBytes: free } : {}),
    ...(str(nvidia["driver_version"]) ? { driverVersion: str(nvidia["driver_version"]) } : {}),
    ...(str(root["OS Version"]) ? { osVersion: str(root["OS Version"]) } : {}),
    ...(explainNoAccelerator(raw) ? { note: explainNoAccelerator(raw) } : {}),
  };
}

/**
 * Why no accelerator is being used, in the machine's own words.
 *
 * Karen used to construct this itself from `nvidia-smi`, because ggml reports
 * "your driver is too old" and "you have no graphics card" identically. That
 * work is no longer needed: every device carries its own `error`, and every
 * backend a `message`. Preferring those to a sentence written here means the
 * explanation stays true as upstream's support changes.
 *
 * Returns undefined when there is an accelerator, or when nothing can be said
 * -- an absent answer being better than an invented one.
 */
export function explainNoAccelerator(raw: unknown): string | undefined {
  if (parseDevices(raw).length) return undefined;
  const devices = obj(obj(raw)["devices"]);
  const reasons: string[] = [];
  for (const key of ["nvidia_gpu", "amd_gpu", "intel_gpu"]) {
    const first = Array.isArray(devices[key]) ? obj(arr(devices[key])[0]) : obj(devices[key]);
    const why = str(first["error"]);
    if (why) reasons.push(why);
  }
  /* `metal` on Linux and `system` -- which means "a llama.cpp you installed
     yourself" -- are not diagnoses. Neither says anything about why this
     machine has no accelerator, and both crowd out the reason that does. */
  const blocked = parseBackends(raw)
    .filter((b) => b.state === "unsupported" && b.message && b.id !== "system"
      && !/requires macOS/i.test(b.message))
    .map((b) => `${b.id}: ${b.message}`);

  if (!reasons.length && !blocked.length) return undefined;
  const head = reasons.length
    ? reasons.join(" ")
    : "No graphics accelerator could be used on this machine.";
  return blocked.length ? `${head} (${blocked.join("; ")})` : head;
}

/**
 * One progress tick from a pull the caller is awaiting.
 *
 * Distinct from `DownloadJob`, which is what `/api/v1/downloads` reports about
 * the daemon's own background work. That endpoint stays empty throughout a
 * `/pull`, so a caller who wants to show progress has to read the event stream
 * the pull itself returns -- see `pullModel`.
 */
export interface PullProgress {
  /** The file being fetched right now, of `totalFiles`. */
  file: string;
  fileIndex: number;
  totalFiles: number;
  bytesDone: number;
  bytesTotal: number;
  percent: number;
}

/** One transfer the daemon is running on our behalf. */
export interface DownloadJob {
  id: string;
  /** `model` or `backend`. */
  kind: string;
  label: string;
  status: string;
  percent?: number | undefined;
  bytesDone?: number | undefined;
  bytesTotal?: number | undefined;
  complete: boolean;
}

/**
 * Read `/v1/downloads`, which is how progress is reported for everything.
 *
 * Karen used to own its own download progress because it did its own
 * downloading. Now the daemon fetches backends and models, and this is the only
 * window onto it -- so a reload or a reconnect can pick a transfer back up
 * rather than losing sight of it, which the old in-process progress could not
 * do.
 */
export function parseDownloads(raw: unknown): DownloadJob[] {
  return arr(raw).map((value) => {
    const job = obj(value);
    const percent = job["percent"];
    const done = job["bytes_downloaded"];
    const total = job["bytes_total"];
    return {
      id: str(job["id"]) ?? "",
      kind: str(job["type"]) ?? "",
      label: str(job["model_name"]) ?? str(job["file"]) ?? str(job["id"]) ?? "",
      status: str(job["status"]) ?? "",
      complete: job["complete"] === true,
      ...(typeof percent === "number" ? { percent } : {}),
      ...(typeof done === "number" ? { bytesDone: done } : {}),
      ...(typeof total === "number" ? { bytesTotal: total } : {}),
    };
  }).filter((j) => j.id);
}
