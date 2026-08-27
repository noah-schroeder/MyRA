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
  /** `installed`, `installable`, `unsupported`. */
  state: string;
  /** Upstream's own sentence about this backend. */
  message?: string | undefined;
  version?: string | undefined;
}

export interface MachineInfo {
  devices: Device[];
  /** Total system memory, when it could be read. */
  ramBytes?: number | undefined;
  /** Free bytes where models are stored. */
  modelStorageFreeBytes?: number | undefined;
  backends: BackendOption[];
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

/** Candidate keys for a device's memory; see the header for why there are several. */
const MEMORY_KEYS = [
  "memory_bytes", "memory_total_bytes", "total_bytes",
  "memory_mb", "memory_total", "total_memory", "memory", "vram_mb", "vram",
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
  for (const key of MEMORY_KEYS) {
    if (key in entry) {
      const bytes = toBytes(entry[key]);
      if (bytes) return bytes;
    }
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
    return {
      id,
      state: str(entry["state"]) ?? "unknown",
      ...(str(entry["message"]) ? { message: str(entry["message"]) } : {}),
      ...(str(entry["version"]) ? { version: str(entry["version"]) } : {}),
    };
  });
}

/** Backends that could be installed and would actually work here. */
export function installableBackends(backends: BackendOption[]): BackendOption[] {
  return backends.filter((b) => b.state === "installable" || b.state === "installed");
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
