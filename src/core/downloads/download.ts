/**
 * A model download, as a thing with a life of its own.
 *
 * It was a local variable in the models page: one `pulling` name, one `job`
 * progress object, both thrown away when the page unmounted. The transfer
 * itself never stopped -- it is a fetch in the main process and has never
 * heard of a page -- but every sign of it did, which is indistinguishable from
 * it having stopped, and there was no way to stop one on purpose either.
 *
 * So a download is a record with a state, held where it can outlive any
 * screen, and this file is the part of it that has no opinions about disks or
 * sockets: what it is called, how far along, how fast, how much longer.
 */

export type DownloadState = "running" | "paused" | "done" | "failed";

export interface Download {
  /** Stable for the life of the transfer; the handle pause and cancel use. */
  id: string;
  /** The model name Lemonade registers it under, e.g. `user.Qwen3-30B`. */
  name: string;
  /** What a person calls it. */
  label: string;
  checkpoint: string;
  source: string;
  recipe: string;
  state: DownloadState;
  /** Bytes fetched, INCLUDING any resumed from a previous attempt. */
  bytesDone: number;
  bytesTotal: number;
  /** The file now in flight, of `totalFiles`. A repository can hold several. */
  file: string;
  fileIndex: number;
  totalFiles: number;
  startedAt: string;
  updatedAt: string;
  error?: string;
  /**
   * Whether this model was already on disk when the download began.
   *
   * Cancelling deletes what was fetched, and "what was fetched" must never
   * mean the copy that was already there -- re-pulling a model you have, then
   * changing your mind, would otherwise delete the working one.
   */
  replacing: boolean;
  /** For rate and ETA. Sampled, not stored forever. See `observe`. */
  samples: { at: number; bytes: number }[];
}

/** How many progress samples to keep. ~8 seconds at the daemon's tick rate. */
const SAMPLES = 16;

export function newDownload(init: {
  id: string;
  name: string;
  label?: string;
  checkpoint: string;
  source: string;
  recipe: string;
  replacing?: boolean;
  now?: Date;
}): Download {
  const at = (init.now ?? new Date()).toISOString();
  return {
    id: init.id,
    name: init.name,
    label: init.label?.trim() || displayName(init.name),
    checkpoint: init.checkpoint,
    source: init.source,
    recipe: init.recipe,
    state: "running",
    bytesDone: 0,
    bytesTotal: 0,
    file: "",
    fileIndex: 0,
    totalFiles: 0,
    startedAt: at,
    updatedAt: at,
    replacing: init.replacing ?? false,
    samples: [],
  };
}

/**
 * The name without the bookkeeping.
 *
 * Lemonade needs a `user.` prefix on anything pulled with its own checkpoint,
 * which is a fact about the daemon's registry and not something to read in a
 * progress bar.
 */
export function displayName(name: string): string {
  return name.replace(/^user\./, "");
}

/** Fold one progress tick into the record. Pure: returns a new one. */
export function observe(
  download: Download,
  tick: { file: string; fileIndex: number; totalFiles: number; bytesDone: number; bytesTotal: number },
  at = Date.now(),
): Download {
  const samples = [...download.samples, { at, bytes: tick.bytesDone }].slice(-SAMPLES);
  return {
    ...download,
    bytesDone: tick.bytesDone,
    /* Kept rather than overwritten with zero: the daemon reports the real size
       on the first frame and 0 on many of the ones after it, so a bar built
       from the latest value alone collapses to nothing mid-download. */
    bytesTotal: tick.bytesTotal || download.bytesTotal,
    file: tick.file || download.file,
    fileIndex: tick.fileIndex,
    totalFiles: tick.totalFiles,
    updatedAt: new Date(at).toISOString(),
    samples,
  };
}

/** 0–1, or undefined when the total is not known yet. */
export function fraction(d: Download): number | undefined {
  if (!d.bytesTotal) return undefined;
  return Math.max(0, Math.min(1, d.bytesDone / d.bytesTotal));
}

/**
 * Bytes per second over the sample window, or undefined.
 *
 * Measured across the window rather than between the last two ticks: the
 * daemon emits several a second and a single gap of a few milliseconds turns
 * into a rate of hundreds of megabytes, which reads as a bug.
 */
export function rate(d: Download): number | undefined {
  const first = d.samples[0];
  const last = d.samples[d.samples.length - 1];
  if (!first || !last || last === first) return undefined;
  const seconds = (last.at - first.at) / 1000;
  if (seconds <= 0) return undefined;
  const bytes = last.bytes - first.bytes;
  return bytes > 0 ? bytes / seconds : undefined;
}

/** Seconds remaining, or undefined when there is nothing to base it on. */
export function eta(d: Download): number | undefined {
  const speed = rate(d);
  const total = d.bytesTotal;
  if (!speed || !total || d.bytesDone >= total) return undefined;
  return (total - d.bytesDone) / speed;
}

/** What the badge counts: transfers a person would call unfinished. */
export function activeCount(list: readonly Download[]): number {
  return list.filter((d) => d.state === "running" || d.state === "paused").length;
}

/** True when something wants attention rather than merely progressing. */
export function anyFailed(list: readonly Download[]): boolean {
  return list.some((d) => d.state === "failed");
}

/**
 * Wait for a just-finished pull to actually be there, rather than assuming it
 * already is.
 *
 * `Downloads.#run` considers a transfer done the instant the daemon's SSE
 * stream closes, which is a fact about the HTTP connection, not a promise
 * about the daemon's own model index having caught up with what it just
 * wrote to disk -- especially plausible for a repository fetched as several
 * files, where the stream can only close once, after the last of them. A
 * page told to refresh before that catch-up finishes reads an old list and
 * shows nothing for a model whose bytes are already sitting on disk.
 *
 * Retried rather than delayed by a fixed amount: the ordinary case is that
 * the model is already there, and a fixed pause would cost every download
 * that time for a race that mostly does not happen. `list` and `sleep` are
 * injected so this is testable without a daemon or a real clock.
 */
export async function pollForModel<M extends { id: string }>(
  id: string,
  list: () => Promise<M[]>,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<M | undefined> {
  const attempts = opts.attempts ?? 5;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < attempts; attempt++) {
    const found = (await list()).find((m) => m.id === id);
    if (found) return found;
    if (attempt < attempts - 1) await sleep(1000 * (attempt + 1));
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Labels                                                              *
 *                                                                     *
 * Here rather than in the component, because a download is shown in    *
 * three places and three copies of "how do you print 4.1 MB/s" drift.  *
 * ------------------------------------------------------------------ */

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function bytesLabel(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  // One decimal below 10 in the bigger units, none for bytes and kilobytes.
  const digits = unit >= 2 && value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function rateLabel(bytesPerSecond: number | undefined): string {
  return bytesPerSecond === undefined ? "" : `${bytesLabel(bytesPerSecond)}/s`;
}

/**
 * How much longer, in the roundest true unit.
 *
 * Never seconds above a minute and never "0m": a countdown that ticks every
 * second on a forty-minute download is motion for its own sake, and the
 * figure is an estimate from a rate that moves anyway.
 */
export function etaLabel(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return "";
  if (seconds < 60) return "less than a minute left";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m left` : `${hours}h left`;
}

/** The one line under the bar: how far, how fast, how long. */
export function statusLine(d: Download): string {
  if (d.state === "failed") return d.error ?? "Download failed";
  if (d.state === "done") return `${bytesLabel(d.bytesTotal || d.bytesDone)} · finished`;
  const size = d.bytesTotal
    ? `${bytesLabel(d.bytesDone)} of ${bytesLabel(d.bytesTotal)}`
    : bytesLabel(d.bytesDone);
  if (d.state === "paused") return `${size} · paused`;
  const parts = [size, rateLabel(rate(d)), etaLabel(eta(d))].filter(Boolean);
  /* A repository with several files says which one, because a bar that sits
     at 60% for ten minutes is explained by "file 2 of 5" and by nothing else. */
  const which = d.totalFiles > 1 ? `file ${d.fileIndex} of ${d.totalFiles}` : "";
  return [...parts, which].filter(Boolean).join(" · ");
}
