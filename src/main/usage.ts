/**
 * Settings → Usage: where the counts are written, and how the window asks.
 *
 * Every model call is reported from core (usage/context.ts) with what the
 * call measured and who it was for; this file adds what only main knows --
 * which provider an address belongs to, whether that is this machine, what
 * the provider said the model costs, whether recording is switched on -- and
 * appends one line. The API gateway reports its forwarded requests here too,
 * so "who asked" can say "a client of MyRA's API" as well as "MyRA".
 *
 * A separate module for the reason every `install*Ipc` is one: index.ts is
 * already the longest file in the app, and the recorder has to exist before
 * the gateway is constructed, which is long before IPC is installed.
 */

import { writeFile } from "node:fs/promises";

import { dialog, ipcMain } from "electron";

import type { ConfigStore } from "../core/config.ts";
import type { RequestRecord } from "../core/api/log.ts";
import {
  selectRecords, summarize, USAGE_DIMENSIONS, type ProjectContext, type UsageQuery,
} from "../core/usage/aggregate.ts";
import { classifyEndpoint } from "../core/usage/classify.ts";
import { setUsageSink, type UsageEvent, type UsageTags } from "../core/usage/context.ts";
import { usageCsv } from "../core/usage/export.ts";
import { UsageLog } from "../core/usage/log.ts";
import { Coalescer } from "../core/usage/coalesce.ts";
import { addDays, daysIn, localDay, parseDay } from "../core/usage/range.ts";
import { countsTokens, type UsageFeature, type UsageKind, type UsageRecord } from "../core/usage/record.ts";
import { ownerOf, type Member } from "../core/projects/project.ts";
import { readAll as readAllProjects } from "./projectStore.ts";

export interface UsageDeps {
  config: ConfigStore;
  send: (channel: string, payload?: unknown) => void;
  /** The local daemon's address while it is up, chat model loaded or not. */
  runtimeBaseUrl: () => string | undefined;
}

export interface UsageRecorder {
  log: UsageLog;
  /** For the gateway's `onSettled`. */
  recordApi: (record: RequestRecord, upstream: string) => void;
  /** Write whatever is still held and wait for the disk, before quitting. */
  flush: () => Promise<void>;
  /** Delete every record, including any API burst still waiting to be written. */
  clear: () => Promise<void>;
}

/**
 * A call nobody tagged is still counted. Speech, transcription and images
 * are named after what they are, unless a meeting asked for them: dictation
 * and a spoken reply are triggered from the window, outside any feature that
 * could tag them, and "other" would hide the commonest uses of both.
 */
function featureFor(kind: UsageKind, tagged: UsageFeature | undefined): UsageFeature {
  if (kind === "transcription") return tagged === "meeting" ? "meeting" : "dictation";
  if (kind === "speech") return "voice";
  if (kind === "image") return "image";
  return tagged ?? "other";
}

/** The kind of call a gateway path is, for the "other models" panel. */
function kindOfPath(path: string): UsageKind {
  if (/\/embed/.test(path)) return "embeddings";
  if (/\/audio\/transcriptions/.test(path)) return "transcription";
  if (/\/audio\/speech/.test(path)) return "speech";
  if (/\/images\//.test(path)) return "image";
  return "text";
}

export function createUsageRecorder(deps: UsageDeps): UsageRecorder {
  const log = new UsageLog();
  /* The last address the daemon was seen at. A transcription that finishes
     just as the daemon restarts must still be recognised as this computer
     rather than as "127.0.0.1:41234". */
  let lastRuntime: string | undefined;
  const runtimeUrl = (): string | undefined => {
    const now = deps.runtimeBaseUrl();
    if (now) lastRuntime = now;
    return lastRuntime;
  };

  /* At most one "changed" a second: a research run's screening stage reports
     a call every few hundred milliseconds, and each one makes an open
     dashboard ask for a fresh summary. */
  let pending: NodeJS.Timeout | undefined;
  const changed = (): void => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = undefined;
      deps.send("myra:usage-changed");
    }, 1000);
    pending.unref?.();
  };

  const append = (record: UsageRecord): void => {
    if (deps.config.current.recordUsage === false) return;
    void log.append(record).then(changed);
  };

  const fromEvent = (event: UsageEvent, tags: UsageTags): UsageRecord => {
    const settings = deps.config.current;
    const where = classifyEndpoint(event.baseUrl, event.model, {
      providers: settings.providers,
      runtimeBaseUrl: runtimeUrl(),
      llmBaseUrl: settings.llm.baseUrl,
    });
    return {
      v: 1,
      at: new Date().toISOString(),
      kind: event.kind,
      source: "app",
      feature: featureFor(event.kind, tags.feature),
      model: event.model,
      provider: where.provider,
      where: where.where,
      ...(tags.project ? { project: tags.project } : {}),
      ...(tags.item ? { item: tags.item } : {}),
      ...(tags.stage ? { stage: tags.stage } : {}),
      ...(event.input !== undefined ? { input: event.input } : {}),
      ...(event.output !== undefined ? { output: event.output } : {}),
      ...(event.cached !== undefined ? { cached: event.cached } : {}),
      ...(event.reasoning !== undefined ? { reasoning: event.reasoning } : {}),
      ms: event.ms,
      ...(event.ttftMs !== undefined ? { ttftMs: event.ttftMs } : {}),
      ...(event.genMs !== undefined ? { genMs: event.genMs } : {}),
      outcome: event.outcome,
      /* Only a token price, and only on a token-counted call: a provider's
         price list says nothing about what a second of audio costs. */
      ...(where.price && countsTokens(event.kind) ? { price: where.price } : {}),
      ...(event.units !== undefined ? { units: event.units } : {}),
    };
  };

  setUsageSink((event, tags) => append(fromEvent(event, tags)));

  /* Gateway requests go through the coalescer: a client stuck retrying an
     instant failure would otherwise write a line per attempt, hundreds a
     second. Held at most a second, merged, totals exact (coalesce.ts). */
  const apiBursts = new Coalescer(append);

  const recordApi = (r: RequestRecord, upstream: string): void => {
    const kind = kindOfPath(r.path);
    const outcome =
      r.state === "cancelled" ? "cancelled" : r.state === "error" || (r.status ?? 200) >= 400 ? "error" : "ok";
    const where = classifyEndpoint(upstream, r.model ?? "", {
      providers: deps.config.current.providers,
      runtimeBaseUrl: runtimeUrl() ?? upstream,
    });
    apiBursts.add({
      v: 1,
      at: new Date().toISOString(),
      kind,
      source: "api",
      feature: "api",
      model: r.model ?? "",
      provider: where.provider,
      where: where.where,
      key: { id: r.keyId, label: r.keyLabel },
      ...(r.promptTokens !== undefined ? { input: r.promptTokens } : {}),
      ...(r.completionTokens !== undefined ? { output: r.completionTokens } : {}),
      ms: r.durationMs ?? 0,
      outcome,
    });
  };

  const flush = async (): Promise<void> => {
    apiBursts.flush();
    await log.flush();
  };

  const clear = async (): Promise<void> => {
    apiBursts.discard();
    await log.clear();
  };

  return { log, recordApi, flush, clear };
}

/**
 * The tags for work on one project member: the member itself, so whichever
 * project holds it later claims its usage, and the project holding it now --
 * or the active one it is about to be filed into -- remembered by name for
 * the day the member, or the project, is deleted.
 */
export async function memberUsage(
  feature: UsageFeature,
  item: Member,
  activeProject?: string,
): Promise<UsageTags> {
  const projects = await readAllProjects().catch(() => []);
  const project = ownerOf(projects, item) ?? (activeProject ? projects.find((p) => p.id === activeProject) : undefined);
  return {
    feature,
    item: { kind: item.kind, ref: item.ref },
    ...(project ? { project: { id: project.id, name: project.name } } : {}),
  };
}

/** Every member, to the project holding it -- read fresh for each question. */
async function projectContext(): Promise<ProjectContext> {
  const projects = await readAllProjects().catch(() => []);
  const names = new Map<string, string>();
  const owners = new Map<string, string>();
  for (const p of projects) {
    names.set(p.id, p.name);
    for (const m of p.members) owners.set(`${m.kind}:${m.ref}`, p.id);
  }
  return { names, owners };
}

/** Twenty years: longer than any record this app has kept, shorter than a typo. */
const MAX_DAYS = 366 * 20;

/**
 * The query as the window sent it, checked: two real days in order, and a
 * span no longer than the record could plausibly hold, so a mistyped year in
 * the custom range does not walk ten thousand months of file names.
 */
function cleanQuery(raw: unknown): UsageQuery {
  const q = (raw ?? {}) as Partial<UsageQuery>;
  const today = localDay(new Date());
  let from = typeof q.range?.from === "string" && parseDay(q.range.from) ? q.range.from : today;
  let to = typeof q.range?.to === "string" && parseDay(q.range.to) ? q.range.to : today;
  if (to < from) [from, to] = [to, from];
  if (daysIn({ from, to }) > MAX_DAYS) from = addDays(to, -(MAX_DAYS - 1));
  return {
    range: { from, to },
    ...(q.filters && typeof q.filters === "object" ? { filters: q.filters } : {}),
    ...(q.splitBy && (USAGE_DIMENSIONS as readonly string[]).includes(q.splitBy) ? { splitBy: q.splitBy } : {}),
  };
}

export function installUsageIpc(deps: Omit<UsageDeps, "runtimeBaseUrl"> & { usage: UsageRecorder }): void {
  const { log } = deps.usage;

  ipcMain.handle("myra:usage-summary", async (_e, raw: unknown) => {
    try {
      const query = cleanQuery(raw);
      const [records, ctx, earliest] = await Promise.all([log.read(query.range), projectContext(), log.earliest()]);
      return {
        ok: true,
        summary: summarize(records, query, ctx),
        recording: deps.config.current.recordUsage !== false,
        ...(earliest ? { earliest } : {}),
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("myra:usage-clear", async () => {
    try {
      await deps.usage.clear();
      deps.send("myra:usage-changed");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  /*
   * A save dialog, not a file dropped in Documents: this is a record of what
   * somebody worked on and when, and where it goes is their call. Written
   * with the ordinary mode for the same reason -- a directory the user chose
   * is theirs, which is the rule paths.ts states.
   */
  ipcMain.handle("myra:usage-export", async (_e, raw: unknown) => {
    try {
      const query = cleanQuery(raw);
      const [records, ctx] = await Promise.all([log.read(query.range), projectContext()]);
      const rows = selectRecords(records, query, ctx);
      const chosen = await dialog.showSaveDialog({
        title: "Export usage",
        defaultPath: `myra-usage-${query.range.from}-to-${query.range.to}.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (chosen.canceled || !chosen.filePath) return { ok: true, saved: false };
      await writeFile(chosen.filePath, usageCsv(rows, ctx), "utf8");
      return { ok: true, saved: true, path: chosen.filePath, rows: rows.length };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
}
