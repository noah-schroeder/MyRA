/**
 * The usage record on disk: one JSON line per model call, one file per month.
 *
 * `CONFIG_DIR/usage/YYYY-MM.jsonl`, owner-only like everything else MyRA
 * writes. Append-only, because a research run makes hundreds of calls and
 * rewriting a growing file after each would cost more than the calls it
 * counts; one file per month, because a dashboard asking about last week
 * should open one or two files rather than a year of history.
 *
 * Reads are incremental. The current month's file grows while the dashboard is
 * open and is re-read after every call it shows, so each file's parsed lines
 * are kept along with how far into it they reach, and only what was appended
 * since is read again.
 */

import { appendFile, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR, makeOwnDir, OWNER_ONLY_FILE } from "../paths.ts";
import { parseUsageRecord, type UsageRecord } from "./record.ts";
import { localDay, localMonth, monthsIn, type DateRange } from "./range.ts";

const FILE = /^(\d{4}-\d{2})\.jsonl$/;

interface Cached {
  size: number;
  mtimeMs: number;
  /** Byte offset just past the last complete line read. */
  consumed: number;
  records: UsageRecord[];
}

export class UsageLog {
  readonly dir: string;
  #chain: Promise<unknown> = Promise.resolve();
  #cache = new Map<string, Cached>();
  #earliest: { path: string; size: number; mtimeMs: number; day: string | undefined } | undefined;

  constructor(dir: string = join(CONFIG_DIR, "usage")) {
    this.dir = dir;
  }

  fileFor(month: string): string {
    return join(this.dir, `${month}.jsonl`);
  }

  /**
   * Add one record, after every append already queued.
   *
   * Serialised because two calls finishing in the same instant -- a review's
   * reviewers, a gateway client beside a chat turn -- would otherwise write
   * through two handles at once, and one line torn into the middle of another
   * is lost on read. Never rejects: counting must not fail what it counts.
   */
  append(record: UsageRecord): Promise<void> {
    /* Rebuilt field by field before it is written, so nothing a caller hung on
       the object -- a prompt, a reply, a key -- can reach the file. The record
       type has no field for content; this makes that true on disk as well as
       in the type checker. */
    const clean = parseUsageRecord(record);
    if (!clean) return Promise.resolve();
    const write = async (): Promise<void> => {
      await makeOwnDir(this.dir);
      await appendFile(this.fileFor(localMonth(new Date(clean.at))), JSON.stringify(clean) + "\n", {
        encoding: "utf8",
        mode: OWNER_ONLY_FILE,
      });
    };
    const run = this.#chain.then(write, write);
    this.#chain = run.catch(() => undefined);
    return run.catch(() => undefined);
  }

  /** Wait for every queued append, for tests and for an export straight after a call. */
  async flush(): Promise<void> {
    await this.#chain;
  }

  /** Every month with a file, oldest first. */
  async months(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    return names
      .map((n) => FILE.exec(n)?.[1])
      .filter((m): m is string => Boolean(m))
      .sort();
  }

  /**
   * The first day anything was recorded, for "All time".
   *
   * Asked on every summary, so the answer is kept against the first file's
   * size and time rather than read through the month cache -- which `read`
   * may just have emptied of that month.
   */
  async earliest(): Promise<string | undefined> {
    const [first] = await this.months();
    if (!first) return undefined;
    const path = this.fileFor(first);
    const info = await stat(path).catch(() => undefined);
    if (!info) return undefined;
    const known = this.#earliest;
    if (known && known.path === path && known.size === info.size && known.mtimeMs === info.mtimeMs) return known.day;
    const records = this.#cache.get(path)?.records ?? (await this.#parseWhole(path));
    let min: string | undefined;
    for (const r of records) {
      const day = localDay(new Date(r.at));
      if (!min || day < min) min = day;
    }
    this.#earliest = { path, size: info.size, mtimeMs: info.mtimeMs, day: min };
    return min;
  }

  /** The records whose local day falls inside the range. */
  async read(range: DateRange): Promise<UsageRecord[]> {
    await this.flush();
    const months = monthsIn(range);
    /* Only the months this question covers stay parsed. A year of research
       runs is hundreds of thousands of records, and keeping every month ever
       looked at would hold all of them in the main process for the rest of
       the session; the months still on screen are the ones a live refresh
       will ask about again. */
    const wanted = new Set(months.map((m) => this.fileFor(m)));
    for (const path of this.#cache.keys()) if (!wanted.has(path)) this.#cache.delete(path);
    const out: UsageRecord[] = [];
    for (const month of months) {
      for (const r of await this.#readMonth(month)) {
        const day = localDay(new Date(r.at));
        if (day >= range.from && day <= range.to) out.push(r);
      }
    }
    return out;
  }

  /** One file, start to end, without touching the cache. */
  async #parseWhole(path: string): Promise<UsageRecord[]> {
    const text = await readFile(path, "utf8").catch(() => "");
    const out: UsageRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = parseUsageRecord(JSON.parse(line));
        if (record) out.push(record);
      } catch {
        // A torn line, as in #readMonth.
      }
    }
    return out;
  }

  async #readMonth(month: string): Promise<UsageRecord[]> {
    const path = this.fileFor(month);
    let info: { size: number; mtimeMs: number };
    try {
      info = await stat(path);
    } catch {
      this.#cache.delete(path);
      return [];
    }
    let cached = this.#cache.get(path);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.records;
    /* Shrunk means replaced -- cleared, or edited by hand -- and the offset no
       longer means anything. Start again. */
    if (!cached || info.size < cached.consumed) {
      cached = { size: 0, mtimeMs: 0, consumed: 0, records: [] };
    }

    const handle = await open(path, "r");
    let text: string;
    try {
      const length = info.size - cached.consumed;
      const buffer = Buffer.alloc(Math.max(0, length));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, cached.consumed);
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }

    /* Only complete lines are taken. A line still being written has no
       newline yet; it is left for the next read rather than parsed torn and
       then skipped for ever. */
    const end = text.lastIndexOf("\n");
    const complete = end === -1 ? "" : text.slice(0, end);
    const records = [...cached.records];
    for (const line of complete.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = parseUsageRecord(JSON.parse(line));
        if (record) records.push(record);
      } catch {
        // One torn line (a crash mid-append) must not lose the rest.
      }
    }
    const next: Cached = {
      size: info.size,
      mtimeMs: info.mtimeMs,
      consumed: cached.consumed + Buffer.byteLength(end === -1 ? "" : text.slice(0, end + 1), "utf8"),
      records,
    };
    this.#cache.set(path, next);
    return records;
  }

  /** Forget everything. The directory stays, empty, so its mode does too. */
  async clear(): Promise<void> {
    await this.flush();
    for (const month of await this.months()) {
      await rm(this.fileFor(month), { force: true });
    }
    this.#cache.clear();
    this.#earliest = undefined;
  }
}
