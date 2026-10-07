/**
 * Who a model call is for, without passing it through every function on the way.
 *
 * Every model call reaches the network through a handful of functions --
 * `chat()` above all -- and none of them knows whether it is answering a chat
 * turn, screening papers for a research run or writing a reviewer's report.
 * Threading a "feature" and a "project" argument down through eight research
 * stages, the drafter, the reviewer and the meeting notes would touch dozens of
 * signatures that have nothing to do with counting, and the first new caller to
 * forget it would be counted as nobody's.
 *
 * So the place that knows -- a chat turn, a review, a draft -- wraps its work in
 * `withUsage`, and the call at the bottom reads the tags back from
 * `AsyncLocalStorage`, which follows the work through every `await`. A call
 * nobody wrapped is still counted, as "other": the sink never drops one for
 * want of a label.
 *
 * Imports `node:async_hooks`, so this is main-only, like chat.ts itself. Main
 * installs the sink (`setUsageSink`) the way it installs the endpoint resolver,
 * so nothing here learns about Electron, the disk or the settings.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { UsageFeature, UsageKind, UsageOutcome } from "./record.ts";

export interface UsageTags {
  feature?: UsageFeature;
  project?: { id: string; name: string };
  /** What the call is part of -- a project member, so filing it later moves its usage too. */
  item?: { kind: string; ref: string };
  stage?: string;
}

/** What the calling code measured. Main adds who, where and what it cost. */
export interface UsageEvent {
  kind: UsageKind;
  /** Where the request went, which is how main tells a provider from the runtime. */
  baseUrl: string;
  model: string;
  outcome: UsageOutcome;
  ms: number;
  ttftMs?: number;
  genMs?: number;
  input?: number;
  output?: number;
  cached?: number;
  reasoning?: number;
  units?: number;
}

export type UsageSink = (event: UsageEvent, tags: UsageTags) => void;

const store = new AsyncLocalStorage<UsageTags>();
let sink: UsageSink | undefined;

/**
 * Run `fn` with these tags added to whatever tags are already in force.
 *
 * A fresh object every time, never the outer one mutated: two research runs,
 * or a review and a chat turn, overlap in time, and a shared object would let
 * one relabel the other's calls.
 */
export function withUsage<T>(tags: UsageTags, fn: () => T): T {
  const next: UsageTags = { ...store.getStore() };
  if (tags.feature) next.feature = tags.feature;
  if (tags.project) next.project = tags.project;
  if (tags.item) next.item = tags.item;
  /* A stage belongs to the run that set it; a feature wrapped inside one is
     its own work, not the stage's. */
  if (tags.stage) next.stage = tags.stage;
  else if (tags.feature) delete next.stage;
  return store.run(next, fn);
}

export function currentUsageTags(): UsageTags {
  return store.getStore() ?? {};
}

/**
 * Mark which stage a research run has reached.
 *
 * The pipeline announces each stage through a callback that runs inside the
 * run's own context, so setting it on that context's tags labels every call the
 * stage makes. Only a research context is touched: the same callback reached
 * from anywhere else must not leave a stage stuck on a chat turn.
 */
export function noteUsageStage(stage: string): void {
  const tags = store.getStore();
  if (tags?.feature === "research") tags.stage = stage;
}

/** Install where events go. `undefined` stops recording entirely. */
export function setUsageSink(fn: UsageSink | undefined): void {
  sink = fn;
}

/**
 * Hand one finished call to whoever is recording.
 *
 * Never throws and never waits: counting is bookkeeping, and a full disk or a
 * bug in the dashboard must not be able to fail the reply it was counting.
 */
export function reportUsage(event: UsageEvent): void {
  if (!sink) return;
  try {
    sink(event, currentUsageTags());
  } catch {
    // See above.
  }
}

/**
 * Time a call that has no token counts and report how it ended.
 *
 * For transcription, speech and images, which are one request each and are
 * counted in what they consume rather than in tokens. `units` reads the result
 * when there is one; a failed call reports none.
 */
export async function reportingUsage<T>(
  base: Pick<UsageEvent, "kind" | "baseUrl" | "model"> & { units?: number },
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
  units?: (result: T) => number | undefined,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    const n = units?.(result) ?? base.units;
    reportUsage({
      kind: base.kind,
      baseUrl: base.baseUrl,
      model: base.model,
      outcome: "ok",
      ms: Date.now() - started,
      ...(n !== undefined ? { units: n } : {}),
    });
    return result;
  } catch (err) {
    reportUsage({
      kind: base.kind,
      baseUrl: base.baseUrl,
      model: base.model,
      outcome: signal?.aborted ? "cancelled" : "error",
      ms: Date.now() - started,
    });
    throw err;
  }
}
