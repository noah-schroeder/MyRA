/**
 * The run directory: checkpointing, resumability, and the audit trail.
 *
 * A deep run takes the better part of an hour, so it cannot be an in-memory
 * process that dies with the tool call. Every stage writes its output to disk
 * and is skipped when that output already exists. Three things fall out of
 * that, none of which is extra work:
 *
 *   - pause and resume, and recovery from a crash mid-run
 *   - changing one stage's model and re-running only from there
 *   - the PRISMA-style counts, which are just the file lengths
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { researchRoot } from "./config.ts";
import type { SourceRecord } from "./sources.ts";
import { makePrivateDir, OWNER_ONLY_FILE } from "../paths.ts";

/** Stages in execution order. A run resumes at the first one with no output. */
export const STAGES = [
  "scope", "plan", "discover", "screen", "snowball", "retrieve",
  "extract", "synthesize", "verify", "review", "revise",
] as const;
export type Stage = (typeof STAGES)[number];

/** The file that marks a stage complete. */
const STAGE_OUTPUT: Record<Stage, string> = {
  scope: "scope.json",
  plan: "plan.md",
  discover: "candidates.jsonl",
  screen: "screened.jsonl",
  // Written even when snowballing is off, so the stage is skipped on resume
  // rather than re-run for a traversal that was never wanted.
  snowball: "snowball.jsonl",
  retrieve: "sources/index.jsonl",
  extract: "claims.jsonl",
  synthesize: "draft.md",
  verify: "verification.jsonl",
  review: "review.md",
  revise: "report.md",
};

/** A short, human-legible, filesystem-safe run id: date plus a topic slug. */
export function runId(question: string, now = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  const slug = question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 6)
    .join("-")
    .slice(0, 60);
  // Real entropy, not a hash of the timestamp: two runs started in the same
  // millisecond would hash identically, collide on directory, and silently
  // overwrite each other's outputs.
  const salt = randomBytes(2).toString("hex");
  return `${date}-${slug || "research"}-${salt}`;
}

/**
 * A run id, refused if it is anything but one.
 *
 * Run ids are made by `runId` above, but they arrive back from the
 * renderer -- `research-run`, `research-source`, `research-reveal` -- and are
 * joined onto the research root to make a directory that is then read from and
 * opened in the file manager. Checking costs a regex.
 */
export function assertRunId(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") {
    throw new Error(`no research run named ${JSON.stringify(id)}`);
  }
  return id;
}

export class ResearchRun {
  readonly id: string;
  readonly dir: string;

  constructor(id: string, root = researchRoot()) {
    this.id = id;
    this.dir = join(root, id);
  }

  static async create(question: string, root = researchRoot()): Promise<ResearchRun> {
    const run = new ResearchRun(runId(question), root);
    await makePrivateDir(join(run.dir, "sources"));
    await run.writeJson("question.json", { question, startedAt: new Date().toISOString() });
    return run;
  }

  /** Reopen an existing run, for resuming. */
  static async open(id: string, root = researchRoot()): Promise<ResearchRun> {
    const run = new ResearchRun(assertRunId(id), root);
    if (!existsSync(run.dir)) throw new Error(`no research run named "${id}"`);
    return run;
  }

  static async list(root = researchRoot()): Promise<string[]> {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
    } catch {
      return [];
    }
  }

  path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  /** Has this stage already produced its output? */
  isDone(stage: Stage): boolean {
    return existsSync(this.path(STAGE_OUTPUT[stage]));
  }

  /**
   * Where a resumed run picks up: the first stage with no output.
   *
   * A gap with a completed stage AFTER it is not an unfinished run, it is a
   * run from before that stage existed. Adding `snowball` between screen and
   * retrieve would otherwise have made every previously completed run report
   * itself as "unfinished at snowball" -- rewriting history in the run list
   * rather than describing it.
   */
  nextStage(): Stage | undefined {
    const done = STAGES.map((s) => this.isDone(s));
    const lastDone = done.lastIndexOf(true);
    for (const [i, stage] of STAGES.entries()) {
      if (!done[i] && i > lastDone) return stage;
    }
    return undefined;
  }

  /* ---------------- io ---------------- */

  /**
   * Write atomically.
   *
   * A stage's output file is also its "done" marker, so a half-written file
   * would make a crashed stage look complete and be skipped on resume.
   */
  async write(name: string, contents: string): Promise<void> {
    const target = this.path(name);
    await makePrivateDir(join(target, ".."));
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, contents, { encoding: "utf8", mode: OWNER_ONLY_FILE });
    await rename(tmp, target);
  }

  async writeJson(name: string, value: unknown): Promise<void> {
    await this.write(name, JSON.stringify(value, null, 2) + "\n");
  }

  async readJson<T>(name: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.path(name), "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  async readText(name: string): Promise<string | undefined> {
    try {
      return await readFile(this.path(name), "utf8");
    } catch {
      return undefined;
    }
  }

  /**
   * Append one record to a JSONL file.
   *
   * Append rather than rewrite so a long stage's progress survives a crash, and
   * so a partially-screened set is still inspectable.
   */
  async append(name: string, record: unknown): Promise<void> {
    await makePrivateDir(join(this.path(name), ".."));
    await appendFile(this.path(name), JSON.stringify(record) + "\n", {
      encoding: "utf8",
      mode: OWNER_ONLY_FILE,
    });
  }

  async readJsonl<T>(name: string): Promise<T[]> {
    const raw = await this.readText(name);
    if (!raw) return [];
    const out: T[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // One torn line (a crash mid-append) must not lose the rest.
      }
    }
    return out;
  }

  /* ---------------- sources ---------------- */

  /**
   * Store a source's full text alongside its record.
   *
   * The text is kept verbatim so quote verification has something to check
   * against, and so a citation can be audited long after the page changed.
   */
  async saveSource(record: SourceRecord, text: string): Promise<void> {
    await makePrivateDir(this.path("sources", String(record.n)));
    await this.write(join("sources", String(record.n), "text.txt"), text);
    await this.write(join("sources", String(record.n), "meta.json"), JSON.stringify(record, null, 2) + "\n");
    await this.append(join("sources", "index.jsonl"), record);
  }

  async sources(): Promise<SourceRecord[]> {
    const records = await this.readJsonl<SourceRecord>(join("sources", "index.jsonl"));
    // Later writes win, so a re-run of one source replaces rather than duplicates.
    const byN = new Map<number, SourceRecord>();
    for (const r of records) byN.set(r.n, r);
    return [...byN.values()].sort((a, b) => a.n - b.n);
  }

  async sourceText(n: number): Promise<string | undefined> {
    return this.readText(join("sources", String(n), "text.txt"));
  }

  /**
   * Where each source's located passages sit in its stored text.
   *
   * Derived from claims.jsonl rather than stored a second time, so the offsets
   * a reader is shown are necessarily the offsets extraction actually found --
   * there is no second copy to drift. This is what lets a citation be opened at
   * the exact characters it came from instead of at a whole document.
   */
  async spansBySource(): Promise<Map<number, { start: number; end: number; quote: string; claim: string }[]>> {
    const claims = await this.readJsonl<{
      source?: number; start?: number; end?: number; quote?: string; claim?: string;
    }>("claims.jsonl");
    const out = new Map<number, { start: number; end: number; quote: string; claim: string }[]>();
    for (const c of claims) {
      if (typeof c.source !== "number" || typeof c.start !== "number" || typeof c.end !== "number") continue;
      const list = out.get(c.source) ?? [];
      list.push({ start: c.start, end: c.end, quote: c.quote ?? "", claim: c.claim ?? "" });
      out.set(c.source, list);
    }
    for (const list of out.values()) list.sort((a, b) => a.start - b.start);
    return out;
  }

  /** Every stored source's text, for quote verification. */
  async sourceTexts(): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    for (const rec of await this.sources()) {
      const text = await this.sourceText(rec.n);
      if (text !== undefined) map.set(rec.n, text);
    }
    return map;
  }

  /**
   * Append to a stage's output while it is still in progress.
   *
   * A stage's output file is also its "done" marker, so appending directly to
   * it would make a crashed stage look complete: a resumed run would carry on
   * with half a screening pass and never know. Records accumulate in a
   * `.partial` file, which `finalize()` moves into place as the last act of the
   * stage.
   */
  async appendPartial(name: string, record: unknown): Promise<void> {
    await this.append(`${name}.partial`, record);
  }

  /** Publish a stage's output. Creates an empty file if the stage produced none. */
  async finalize(name: string): Promise<void> {
    const partial = this.path(`${name}.partial`);
    if (!existsSync(partial)) {
      await this.write(name, "");
      return;
    }
    await rename(partial, this.path(name));
  }

  /** Records written so far by an unfinished stage. */
  async readPartial<T>(name: string): Promise<T[]> {
    return this.readJsonl<T>(`${name}.partial`);
  }

  /* ---------------- pause ---------------- */

  /**
   * Pause between stages rather than mid-stage.
   *
   * A stage is the unit of work that leaves a complete file behind, so pausing
   * at a boundary is the only kind of pause that resumes cleanly. Asking for a
   * pause during a forty-minute screen therefore takes effect at the next
   * boundary rather than abandoning the batch in flight.
   */
  async pause(): Promise<void> {
    await this.write("PAUSED", `paused at ${new Date().toISOString()}\n`);
  }

  async resume(): Promise<void> {
    await rm(join(this.dir, "PAUSED"), { force: true });
  }

  isPaused(): boolean {
    return existsSync(join(this.dir, "PAUSED"));
  }

  /* ---------------- search log ---------------- */

  /** One line per query issued: what was asked, where, and what came back. */
  async logSearch(entry: {
    query: string;
    source: string;
    category?: string;
    page?: number;
    results: number;
    newResults?: number;
    error?: string;
  }): Promise<void> {
    await this.append("search-log.jsonl", { at: new Date().toISOString(), ...entry });
  }

  /* ---------------- counts ---------------- */

  /**
   * The PRISMA-lite funnel, derived rather than tracked.
   *
   * Nothing here is bookkeeping the pipeline has to remember to do: each number
   * is the length of a file it already wrote.
   */
  async counts(): Promise<{
    found: number; deduped: number; screened: number; read: number; cited: number;
  }> {
    // Snowballed papers are candidates like any other -- they were simply found
    // by traversal rather than by a query -- so they belong in the funnel. A
    // run that reads 40 papers must not report having found 28.
    const candidates = [
      ...(await this.readJsonl<{ dedupeKey?: string }>("candidates.jsonl")),
      ...(await this.readJsonl<{ dedupeKey?: string }>("snowball.jsonl")),
    ];
    // The screening stage writes `include`; accept `keep` too so an older run
    // directory still reports a funnel rather than a silent zero.
    const screened = [
      ...(await this.readJsonl<{ include?: boolean; keep?: boolean }>("screened.jsonl")),
      ...(await this.readJsonl<{ include?: boolean; keep?: boolean }>("screened-snowball.jsonl")),
    ];
    const sources = await this.sources();
    const draft = (await this.readText("report.md")) ?? (await this.readText("draft.md")) ?? "";
    const cited = new Set(
      [...draft.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])).filter((n) => n >= 1 && n <= 999),
    );
    return {
      found: candidates.length,
      deduped: new Set(candidates.map((c) => c.dedupeKey ?? Math.random())).size,
      screened: screened.filter((s) => s.include === true || s.keep === true).length,
      read: sources.length,
      cited: cited.size,
    };
  }

  /**
   * The funnel as one line, for the head of the report.
   *
   * PRISMA-lite on purpose: enough to answer "did I miss something?" and "how
   * did I find this?", without the flow diagrams and dual independent screening
   * that exist to satisfy reviewers this run does not have.
   */
  async funnel(): Promise<string> {
    const c = await this.counts();
    return [
      `${c.found} found`,
      `${c.deduped} deduped`,
      `${c.screened} screened in`,
      `${c.read} read in full`,
      `${c.cited} cited`,
    ].join(" → ");
  }

  /**
   * What the run did, derived entirely from what it wrote.
   *
   * Verification counts come from the same file the reviser had to act on, so
   * this cannot claim a check that never happened.
   */
  async summary(): Promise<string> {
    const checks = await this.readJsonl<{ verdict?: string }>("verification.jsonl");
    const dropped = await this.readJsonl<{ reason?: string }>("dropped-claims.jsonl");
    const lines = [await this.funnel()];
    if (checks.length) {
      const n = (v: string) => checks.filter((c) => c.verdict === v).length;
      lines.push(
        `citations checked: ${n("supports")} supported, ${n("contradicts")} contradicted, ` +
          `${n("does not address")} unsupported, ${n("unchecked")} unchecked`,
      );
    }
    if (dropped.length) {
      lines.push(`${dropped.length} extracted passage(s) discarded as not verbatim in the source`);
    }

    /*
     * A quotation in the finished report that is not in the source it cites.
     *
     * Distinct from the citation verdicts above: those are a model's judgement
     * about whether a passage supports a sentence, and this is a mechanical
     * string check that cannot be wrong.
     */
    const quotes = await this.readJsonl<{ verbatim?: boolean }>("quote-checks.jsonl");
    if (quotes.length) {
      const bad = quotes.filter((q) => q.verbatim !== true).length;
      lines.push(
        bad === 0
          ? `${quotes.length} quotation(s) in the report checked, all verbatim in the cited source`
          : `${bad} of ${quotes.length} quotation(s) in the report are NOT verbatim in the source cited`,
      );
    }

    /*
     * Say plainly when the review was self-review.
     *
     * roles.ts has a reviewerIsSynthesist() for exactly this and nothing ever
     * called it, while resolveRoles falls every role back to the one configured
     * model -- so the DEFAULT configuration is the failure the review stage
     * exists to prevent, and the report said nothing about it. A run that
     * cannot claim independent review must not look as though it can.
     */
    const plan = await this.readJson<{ roles?: Record<string, string> }>("plan.json");
    if (plan?.roles && plan.roles["reviewer"] === plan.roles["synthesist"]) {
      lines.push(
        `review was SELF-REVIEW: the reviewer and the synthesist are both ` +
          `${plan.roles["reviewer"]}, so the critique is not independent`,
      );
    }
    return lines.join("\n");
  }
}

/* ------------------------------------------------------------------ *
 * Reading a finished run                                              *
 * ------------------------------------------------------------------ */

/**
 * Everything a run left behind, assembled for inspection.
 *
 * This is the auditability requirement made reachable. Every field below was
 * already being written to disk on every run -- the search log, the screening
 * reasons, the source hashes, the dropped passages, the verification table --
 * and none of it was visible anywhere in the app. A pipeline whose provenance
 * you cannot read is not auditable, however carefully it recorded things.
 *
 * Read-only and derived: nothing here is a second copy of state the run keeps
 * elsewhere, so this cannot disagree with what actually happened.
 */
export interface RunSearch {
  at: string;
  query: string;
  category?: string;
  page?: number;
  results: number;
  newResults?: number;
  error?: string;
}

export interface RunScreened {
  id: number;
  include: boolean;
  reason: string;
  defaulted?: boolean;
  /** Set when the paper was reached by citation traversal, not by a query. */
  snowballRound?: number;
  /** Joined from candidates.jsonl so a decision is readable on its own. */
  title?: string;
  url?: string;
  year?: number;
  venue?: string;
  foundBy?: number;
}

export interface RunDetail {
  id: string;
  question: string;
  startedAt?: string;
  /** The first stage with no output: where a resumed run would pick up. */
  nextStage?: Stage;
  stages: { stage: Stage; done: boolean }[];
  paused: boolean;
  funnel: string;
  summary: string;
  counts: Awaited<ReturnType<ResearchRun["counts"]>>;
  queries: string[];
  searches: RunSearch[];
  screened: RunScreened[];
  sources: SourceRecord[];
  dropped: { source: number; quote: string; reason: string }[];
  verification: {
    sentenceIndex: number; sentence: string; source: number; verdict: string; note: string;
  }[];
  quoteChecks: { quote: string; citation?: number; verbatim: boolean; reason?: string }[];
  report?: string;
  review?: string;
  bibtex?: string;
}

export async function readRun(id: string, root = researchRoot()): Promise<RunDetail> {
  const run = await ResearchRun.open(id, root);
  const question = await run.readJson<{ question?: string; startedAt?: string }>("question.json");
  const plan = await run.readJson<{ queries?: string[] }>("plan.json");

  // Screening decisions are keyed by candidate id and carry only a reason, so
  // join the candidate back on: "excluded — measures attitudes" is only useful
  // next to the title it excluded.
  type Row = {
    id: number; title?: string; url?: string; year?: number; venue?: string;
    foundBy?: number; round?: number;
  };
  const candidates = [
    ...(await run.readJsonl<Row>("candidates.jsonl")),
    ...(await run.readJsonl<Row>("snowball.jsonl")),
  ];
  const byId = new Map(candidates.map((c) => [c.id, c]));

  const screened = [
    ...(await run.readJsonl<{ id: number; include: boolean; reason: string; defaulted?: boolean }>(
      "screened.jsonl",
    )),
    ...(await run.readJsonl<{ id: number; include: boolean; reason: string; defaulted?: boolean }>(
      "screened-snowball.jsonl",
    )),
  ].map((d) => {
    const c = byId.get(d.id);
    return {
      ...d,
      ...(c?.title ? { title: c.title } : {}),
      ...(c?.url ? { url: c.url } : {}),
      ...(c?.year ? { year: c.year } : {}),
      ...(c?.venue ? { venue: c.venue } : {}),
      ...(c?.foundBy !== undefined ? { foundBy: c.foundBy } : {}),
      // How this paper was found, which is part of the audit trail: a work
      // reached by citation traversal was never returned by any query.
      ...(c?.round !== undefined ? { snowballRound: c.round } : {}),
    };
  });

  const next = run.nextStage();
  return {
    id,
    question: question?.question ?? id,
    ...(question?.startedAt ? { startedAt: question.startedAt } : {}),
    ...(next ? { nextStage: next } : {}),
    stages: STAGES.map((stage) => ({ stage, done: run.isDone(stage) })),
    paused: run.isPaused(),
    funnel: await run.funnel(),
    summary: await run.summary(),
    counts: await run.counts(),
    queries: plan?.queries ?? [],
    searches: await run.readJsonl<RunSearch>("search-log.jsonl"),
    screened,
    sources: await run.sources(),
    dropped: await run.readJsonl("dropped-claims.jsonl"),
    verification: await run.readJsonl("verification.jsonl"),
    quoteChecks: await run.readJsonl("quote-checks.jsonl"),
    ...((await run.readText("report.md")) ? { report: (await run.readText("report.md"))! } : {}),
    ...((await run.readText("review.md")) ? { review: (await run.readText("review.md"))! } : {}),
    ...((await run.readText("sources.bib")) ? { bibtex: (await run.readText("sources.bib"))! } : {}),
  };
}

/** One source's stored text with the passages extraction located in it. */
export async function readRunSource(
  id: string,
  n: number,
  root = researchRoot(),
): Promise<{ record?: SourceRecord; text: string; spans: { start: number; end: number; quote: string; claim: string }[] } | undefined> {
  const run = await ResearchRun.open(id, root);
  const text = await run.sourceText(n);
  if (text === undefined) return undefined;
  const record = (await run.sources()).find((s) => s.n === n);
  return {
    ...(record ? { record } : {}),
    text,
    spans: (await run.spansBySource()).get(n) ?? [],
  };
}

/** Summary rows for the run list, cheap enough to build for every run. */
export async function listRuns(root = researchRoot()): Promise<
  { id: string; question: string; startedAt?: string; funnel: string; nextStage?: Stage; paused: boolean }[]
> {
  const ids = await ResearchRun.list(root);
  const out: {
    id: string; question: string; startedAt?: string; funnel: string; nextStage?: Stage; paused: boolean;
  }[] = [];
  for (const id of ids) {
    try {
      const run = await ResearchRun.open(id, root);
      const q = await run.readJson<{ question?: string; startedAt?: string }>("question.json");
      const next = run.nextStage();
      out.push({
        id,
        question: q?.question ?? id,
        ...(q?.startedAt ? { startedAt: q.startedAt } : {}),
        funnel: await run.funnel(),
        ...(next ? { nextStage: next } : {}),
        paused: run.isPaused(),
      });
    } catch {
      // A half-created directory should not hide every other run.
    }
  }
  return out;
}

/* ------------------------------------------------------------- deleting -- */

/**
 * How recently a run must have been written to for deletion to be refused.
 *
 * There is no lock file: a run is a directory that stages append to, and the
 * pipeline holds no handle that would survive a crash. So "is this running?"
 * is answered by looking at when it was last written to, which is a heuristic
 * and is treated as one -- it refuses, it does not silently wait.
 *
 * Ninety seconds because the long stages are long: screening a hundred
 * abstracts writes one line per decision, and fetching a PDF can be quiet for
 * a while. A window shorter than the gaps between writes would call a live run
 * idle, which is the failure that actually costs something.
 */
export const RUN_ACTIVE_WITHIN_MS = 90_000;

export interface RunFootprint {
  id: string;
  /** Files on disk, so a confirmation can say what is about to go. */
  files: number;
  bytes: number;
  /** Most recent write anywhere in the run, as epoch milliseconds. */
  lastWriteMs: number;
}

/**
 * Resolve a run directory, refusing anything that escapes the research root.
 *
 * `assertRunId` already rejects separators, so this is the second of two
 * checks rather than the only one -- but this function is about to hand a path
 * to `rm -r`, and defence in depth is cheap next to deleting the wrong tree.
 */
function runDir(id: string, root: string): string {
  const dir = resolve(join(root, assertRunId(id)));
  const rel = relative(resolve(root), dir);
  /* `sep`, not "/": on Windows the separator is a backslash, and a check
     spelled with a forward slash there would pass a nested path straight
     through to the `rm` below. `isAbsolute` covers the case where `relative`
     gives up entirely -- a different drive letter -- and returns a path that
     starts with neither. */
  if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || rel.includes(sep) || isAbsolute(rel)) {
    throw new Error(`no research run named ${JSON.stringify(id)}`);
  }
  return dir;
}

/** What a run occupies, and when it was last touched. */
export async function runFootprint(id: string, root = researchRoot()): Promise<RunFootprint> {
  const dir = runDir(id, root);
  if (!existsSync(dir)) throw new Error(`no research run named "${id}"`);
  let files = 0;
  let bytes = 0;
  let lastWriteMs = 0;
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      const info = await stat(join(entry.parentPath, entry.name));
      files += 1;
      bytes += info.size;
      lastWriteMs = Math.max(lastWriteMs, info.mtimeMs);
    } catch {
      // A file that vanished mid-walk is one fewer file, not a failure.
    }
  }
  return { id, files, bytes, lastWriteMs };
}

/**
 * Delete a run and everything it gathered.
 *
 * Irreversible, and it takes the sources with it: the stored copies of every
 * paper the run downloaded live inside the directory, which is the whole point
 * of the audit trail. That is why the caller is expected to have shown the
 * footprint first, and why a run that was written to moments ago is refused
 * rather than removed from under a pipeline that is still appending to it.
 */
export async function deleteRun(
  id: string,
  root = researchRoot(),
  now = Date.now(),
): Promise<{ id: string; files: number; bytes: number }> {
  const footprint = await runFootprint(id, root);
  const since = now - footprint.lastWriteMs;
  if (footprint.lastWriteMs > 0 && since < RUN_ACTIVE_WITHIN_MS) {
    const seconds = Math.max(1, Math.round(since / 1000));
    throw new Error(
      `This run was still being written to ${seconds} ${seconds === 1 ? "second" : "seconds"} ago, ` +
        `so it looks like it is still going. Pause it and try again.`,
    );
  }
  await rm(runDir(id, root), { recursive: true, force: true });
  return { id, files: footprint.files, bytes: footprint.bytes };
}
