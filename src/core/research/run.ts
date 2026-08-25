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
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { researchRoot } from "./config.ts";
import type { SourceRecord } from "./sources.ts";

/** Stages in execution order. A run resumes at the first one with no output. */
export const STAGES = [
  "scope", "plan", "discover", "screen", "retrieve",
  "extract", "synthesize", "verify", "review", "revise",
] as const;
export type Stage = (typeof STAGES)[number];

/** The file that marks a stage complete. */
const STAGE_OUTPUT: Record<Stage, string> = {
  scope: "scope.json",
  plan: "plan.md",
  discover: "candidates.jsonl",
  screen: "screened.jsonl",
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

export class ResearchRun {
  readonly id: string;
  readonly dir: string;

  constructor(id: string, root = researchRoot()) {
    this.id = id;
    this.dir = join(root, id);
  }

  static async create(question: string, root = researchRoot()): Promise<ResearchRun> {
    const run = new ResearchRun(runId(question), root);
    await mkdir(join(run.dir, "sources"), { recursive: true });
    await run.writeJson("question.json", { question, startedAt: new Date().toISOString() });
    return run;
  }

  /** Reopen an existing run, for resuming. */
  static async open(id: string, root = researchRoot()): Promise<ResearchRun> {
    const run = new ResearchRun(id, root);
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

  /** The first stage with no output: where a resumed run picks up. */
  nextStage(): Stage | undefined {
    return STAGES.find((s) => !this.isDone(s));
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
    await mkdir(join(target, ".."), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, contents, "utf8");
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
    await mkdir(join(this.path(name), ".."), { recursive: true });
    await appendFile(this.path(name), JSON.stringify(record) + "\n", "utf8");
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
    await mkdir(this.path("sources", String(record.n)), { recursive: true });
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
    const candidates = await this.readJsonl<{ dedupeKey?: string }>("candidates.jsonl");
    // The screening stage writes `include`; accept `keep` too so an older run
    // directory still reports a funnel rather than a silent zero.
    const screened = await this.readJsonl<{ include?: boolean; keep?: boolean }>("screened.jsonl");
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
