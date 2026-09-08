/**
 * Every model download in flight, in the one process that outlives a screen.
 *
 * The transfer was always here -- a fetch against Lemonade's `/pull` -- but the
 * only record of it lived in the models page's React state, so changing page
 * threw away the progress, the name and the promise, while the bytes kept
 * arriving invisibly. This is that record, moved to where the work is.
 *
 * Three things about the daemon decide the design, and all three were measured
 * against lemond 11.8.0 rather than read from a document:
 *
 *   - A streamed `/pull` never appears in `/api/v1/jobs` or `/api/v1/downloads`.
 *     Both stay empty for its whole duration, so the daemon's own
 *     pause/resume/interrupt job API cannot be used to control one.
 *   - Aborting the request cancels it at the far end: lemond logs
 *     "Client disconnected, cancelling download". So an AbortController IS the
 *     stop button, and nothing else is needed for one.
 *   - Restarting resumes: "Found partial file (73.1 MB), resuming...". So a
 *     pause is an abort that keeps the bytes, and a resume is a fresh pull.
 *
 * No electron import, so this is loadable by the test runner. What touches the
 * daemon arrives injected, the way modelDelete.ts does it.
 */

import {
  newDownload, observe, type Download,
} from "../core/downloads/download.ts";

/** What this needs from the outside world, and nothing more. */
export interface DownloadDeps {
  /**
   * Run one pull, reporting progress, until it finishes or the signal fires.
   *
   * Rejects on abort, which is how a pause and a cancel arrive here.
   */
  pull(args: {
    name: string;
    checkpoint: string;
    source: string;
    recipe: string;
    signal: AbortSignal;
    onProgress: (p: {
      file: string;
      fileIndex: number;
      totalFiles: number;
      bytesDone: number;
      bytesTotal: number;
    }) => void;
  }): Promise<void>;
  /** Ask the daemon to remove a model, files and registration together. */
  remove(name: string): Promise<void>;
  /** Fired whenever the list changes, so the window can redraw. */
  publish(list: Download[]): void;
  /** Called when one finishes, so a model list somewhere can refresh. */
  onFinished?: (name: string) => void;
}

interface Entry {
  record: Download;
  controller: AbortController;
  /** Set while stopping, so the rejection knows which of the two it was. */
  stopping?: "pause" | "cancel" | undefined;
}

/**
 * How often the window is told, at most.
 *
 * The daemon emits several progress frames a second per transfer. Forwarding
 * each one is a React render per frame per download, for a bar that cannot
 * show the difference. Every 250ms is smooth and costs nothing.
 */
const PUBLISH_MS = 250;

export class Downloads {
  readonly #deps: DownloadDeps;
  readonly #entries = new Map<string, Entry>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #dirty = false;
  #seq = 0;

  constructor(deps: DownloadDeps) {
    this.#deps = deps;
  }

  /** The list, newest first, without the internals. */
  list(): Download[] {
    return [...this.#entries.values()]
      .map((e) => e.record)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /**
   * Begin a download, and return at once.
   *
   * Deliberately not awaited by its caller: an IPC handler that awaited this
   * would hold a reply open for an hour, which is the shape the old code had
   * and the reason a download had nowhere to live but the page that started
   * it.
   */
  start(init: {
    name: string;
    label?: string;
    checkpoint: string;
    source: string;
    recipe: string;
    replacing?: boolean;
  }): Download {
    /* Same model, same checkpoint, already going: hand back the one running
       rather than opening a second socket to the same file. Double-clicking a
       download button is not a request for two downloads. */
    const already = [...this.#entries.values()].find(
      (e) =>
        e.record.name === init.name &&
        e.record.checkpoint === init.checkpoint &&
        e.record.state === "running",
    );
    if (already) return already.record;

    const id = `dl-${Date.now().toString(36)}-${(this.#seq++).toString(36)}`;
    const record = newDownload({ id, ...init });
    const controller = new AbortController();
    this.#entries.set(id, { record, controller });
    this.#publishNow();
    void this.#run(id);
    return record;
  }

  /** Stop it, keep the bytes. Restarting resumes from the partial file. */
  pause(id: string): void {
    const entry = this.#entries.get(id);
    if (!entry || entry.record.state !== "running") return;
    entry.stopping = "pause";
    entry.controller.abort();
  }

  /** Start a paused one again, from wherever the partial file reached. */
  resume(id: string): void {
    const entry = this.#entries.get(id);
    if (!entry || entry.record.state !== "paused") return;
    /* A fresh controller: the old one is aborted for good, and reusing it
       would cancel the new request in the same tick. */
    entry.controller = new AbortController();
    entry.record = {
      ...entry.record,
      state: "running",
      /* Cleared, or the rate is computed across the pause and reads as a
         transfer that has slowed to nothing. */
      samples: [],
    };
    this.#publishNow();
    void this.#run(id);
  }

  /**
   * Stop it and throw away what was fetched.
   *
   * The delete goes through the daemon rather than through a path this process
   * works out for itself. Karen does not know where in the Hugging Face cache
   * a given checkpoint's blobs landed -- the directory carries a commit sha it
   * has never seen -- and a routine that guessed would be a routine that
   * guesses while deleting.
   *
   * Never for a model that was already installed: cancelling a re-download
   * must not take the working copy with it.
   */
  async cancel(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (!entry) return;
    const { record } = entry;
    entry.stopping = "cancel";
    entry.controller.abort();
    this.#entries.delete(id);
    this.#publishNow();
    if (record.replacing) return;
    /* Best effort, and after the abort: the daemon holds the file open until
       it notices the client has gone, and a delete racing that loses. */
    await this.#deps.remove(record.name).catch(() => undefined);
  }

  /** Take a finished or failed row off the list. Deletes nothing. */
  dismiss(id: string): void {
    const entry = this.#entries.get(id);
    if (!entry || entry.record.state === "running") return;
    this.#entries.delete(id);
    this.#publishNow();
  }

  /** Every row that is not still going. What "Clear finished" presses. */
  dismissSettled(): void {
    for (const [id, e] of this.#entries) {
      if (e.record.state === "done" || e.record.state === "failed") this.#entries.delete(id);
    }
    this.#publishNow();
  }

  /** Stop everything, for shutdown. Keeps the bytes, deletes nothing. */
  pauseAll(): void {
    for (const id of this.#entries.keys()) this.pause(id);
  }

  async #run(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (!entry) return;
    const { controller } = entry;
    try {
      await this.#deps.pull({
        name: entry.record.name,
        checkpoint: entry.record.checkpoint,
        source: entry.record.source,
        recipe: entry.record.recipe,
        signal: controller.signal,
        onProgress: (p) => this.#observe(id, p),
      });
      /* Filled in rather than left at whatever the last frame said. The
         daemon's final progress event reports 0 bytes for a transfer it has
         just completed, so a finished row read "0 B of 138 MB" beside a full
         bar. */
      this.#settle(id, { state: "done", bytesDone: entry.record.bytesTotal || entry.record.bytesDone });
      this.#deps.onFinished?.(entry.record.name);
    } catch (err) {
      const live = this.#entries.get(id);
      /* Cancelled records are already gone, and a pause is not a failure --
         the message would be "This operation was aborted", printed in red
         under a row the user paused on purpose. */
      if (!live) return;
      if (live.stopping === "pause" || controller.signal.aborted) {
        this.#settle(id, { state: "paused" });
        return;
      }
      this.#settle(id, { state: "failed", error: (err as Error).message });
    }
  }

  #observe(id: string, tick: Parameters<typeof observe>[1]): void {
    const entry = this.#entries.get(id);
    if (!entry || entry.record.state !== "running") return;
    entry.record = observe(entry.record, tick);
    this.#schedule();
  }

  #settle(id: string, patch: Partial<Download>): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    entry.stopping = undefined;
    entry.record = { ...entry.record, ...patch, updatedAt: new Date().toISOString() };
    this.#publishNow();
  }

  /** Coalesce a burst of progress frames into one update. */
  #schedule(): void {
    this.#dirty = true;
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#dirty) this.#publishNow();
    }, PUBLISH_MS);
    /* Never a reason to hold the process open: the transfer's own fetch is
       what keeps it alive, and this is only a redraw. */
    this.#timer.unref?.();
  }

  #publishNow(): void {
    this.#dirty = false;
    this.#deps.publish(this.list());
  }
}
