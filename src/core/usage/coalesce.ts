/**
 * Rapid repeats from API clients, merged into one line a second.
 *
 * Every request the gateway forwards would otherwise be one line on disk, and
 * that is fine at the pace a model answers. It is not fine for a client with a
 * valid key and a bug: a malformed request rejected in a millisecond, retried
 * at once, for ever, is hundreds of lines a second and gigabytes by morning --
 * the retry loop the gateway's own request log is capped against in memory.
 *
 * So requests are held for up to a second and written as one line per kind of
 * request, with `count` saying how many it stands for and every figure summed,
 * which keeps the dashboard's totals exact. "Kind" is everything the dashboard
 * groups or filters by -- key, model, where it ran, outcome -- plus whether the
 * server reported counts at all, so a merged line is never half reported and
 * half not. A burst therefore costs a handful of lines a second however fast it
 * is, and a person using an app normally sees every request as its own line,
 * only a second late.
 */

import type { UsageRecord } from "./record.ts";

/** Everything a merged line must agree on, or the dashboard could split it wrongly. */
export function mergeKey(r: UsageRecord): string {
  return JSON.stringify([
    r.source, r.key?.id ?? "", r.kind, r.feature, r.model, r.provider.id, r.where, r.outcome,
    r.input !== undefined || r.output !== undefined,
  ]);
}

/** Fold `next` into `into`, which already stands for one or more requests. */
export function mergeInto(into: UsageRecord, next: UsageRecord): void {
  into.count = (into.count ?? 1) + (next.count ?? 1);
  into.ms += next.ms;
  /* The latest time, so the line lands in the bucket of the burst's end -- a
     second's difference, except across midnight, where it is a coin toss. */
  if (next.at > into.at) into.at = next.at;
  for (const field of ["input", "output", "cached", "reasoning", "units"] as const) {
    const n = next[field];
    if (n !== undefined) into[field] = (into[field] ?? 0) + n;
  }
  // A key renamed mid-burst is shown by its newest label, as everywhere else.
  if (next.key) into.key = next.key;
}

export class Coalescer {
  readonly #write: (record: UsageRecord) => void;
  readonly #windowMs: number;
  #pending = new Map<string, UsageRecord>();
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(write: (record: UsageRecord) => void, windowMs = 1000) {
    this.#write = write;
    this.#windowMs = windowMs;
  }

  add(record: UsageRecord): void {
    const key = mergeKey(record);
    const held = this.#pending.get(key);
    if (held) mergeInto(held, record);
    else this.#pending.set(key, { ...record, ...(record.key ? { key: { ...record.key } } : {}) });
    if (!this.#timer) {
      this.#timer = setTimeout(() => this.flush(), this.#windowMs);
      // Never the reason the process stays up; quitting flushes explicitly.
      this.#timer.unref?.();
    }
  }

  /**
   * Drop everything held, unwritten -- for clearing the log, so a burst from
   * before the click does not land in a log that is meant to start empty.
   */
  discard(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending.clear();
  }

  /** Write everything held now -- on the timer, and on the way out. */
  flush(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    const held = [...this.#pending.values()];
    this.#pending.clear();
    for (const record of held) this.#write(record);
  }
}
