/**
 * The orchestrator: ten stages, in order, resumable.
 *
 * Two rules make everything else work:
 *
 *   1. Each stage reads the previous stage's output FROM DISK and writes its
 *      own. Nothing is passed in memory between stages.
 *   2. A stage whose output already exists is skipped.
 *
 * Pause, resume, crash recovery, and "change the synthesis model and re-run
 * from stage 7 without re-screening 500 abstracts" all fall out of those two
 * rules rather than being features built on top.
 */

import { effectiveCategory, readResearchConfig } from "./config.ts";
import { isScholarlyCategory } from "./categories.ts";
import { dedupe, searxng, type SearchHit } from "./searxng.ts";
import { canonicalUrl } from "./html.ts";
import { hydrateHits, type Hydrated } from "./hydrate.ts";
import { fetchPage, pooled } from "./fetch.ts";
import { FETCH_CONCURRENCY } from "./config.ts";
import { configuredEmbeddingEndpoint, embedTexts, rankBySimilarity, resolveEndpoint } from "./embed.ts";
import { screenCandidates, type Candidate, type Decision } from "./screen.ts";
import { extractFromSource, type Claim } from "./extract.ts";
import { synthesize } from "./synthesize.ts";
import { verifyDraft, type Check } from "./verify.ts";
import { reviewDraft, reviseDraft } from "./review.ts";
import { makeSourceRecord, renderBibliography, type SourceRecord } from "./sources.ts";
import { generateQueries, parsePlan, renderPlan, type Plan } from "./plan.ts";
import { applyAnswers, draftScope, type Scope, type ScopeQuestion } from "./scope.ts";
import { rubricPath } from "./rubrics.ts";
import { readRoleConfig, resolveRoles } from "./roles.ts";
import type { ResearchRun } from "./run.ts";

/** Just the dialog surface the pipeline needs, so it can be run headless in tests. */
export interface PipelineUi {
  input(title: string, placeholder?: string): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  notify?(message: string, type?: "info" | "warning" | "error"): void;
}

export interface PipelineOptions {
  question: string;
  run: ResearchRun;
  /** The model the app's dropdown is on: the first-run fallback for every role. */
  fallbackModel: string;
  ui: PipelineUi;
  knownModels?: string[];
  signal?: AbortSignal;
  onProgress?: (note: string) => void;
}

export class PausedError extends Error {
  override readonly name = "PausedError";
  readonly runId: string;
  constructor(runId: string, stage: string) {
    super(`paused before "${stage}" — resume with run id ${runId}`);
    this.runId = runId;
  }
}

export class CancelledError extends Error {
  override readonly name = "CancelledError";
}

export interface PipelineResult {
  report: string;
  bibliography: string;
  /** The verified source table, so the GUI can link each [n] in the report. */
  sources: SourceRecord[];
  funnel: string;
  summary: string;
}

export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const { run, ui } = opts;
  const say = (note: string) => opts.onProgress?.(note);

  /**
   * Show a stage's output while it is being produced.
   *
   * A stage runs in another process, so without this the conversation shows a
   * label and then nothing for several minutes -- which is indistinguishable
   * from a hang, and was reported as one. Throttled and tailed: the point is a
   * visible pulse of work, not a transcript.
   */
  const stream = (label: string) => {
    let buffer = "";
    let last = 0;
    return (delta: string, kind: "text" | "thinking") => {
      buffer += delta;
      const now = Date.now();
      if (now - last < 500) return;
      last = now;
      const tail = buffer.replace(/\s+/g, " ").trim().slice(-220);
      say(`${label}${kind === "thinking" ? " (thinking)" : ""}: …${tail}`);
    };
  };
  const cwd = run.path();

  /** Called at every stage boundary — the only place a pause can be honoured. */
  const checkpoint = (stage: string): void => {
    if (opts.signal?.aborted) throw new CancelledError("research cancelled");
    if (run.isPaused()) throw new PausedError(run.id, stage);
  };

  /* ---------------- 1. scope ---------------- */

  checkpoint("scope");
  let scope: Scope;
  if (run.isDone("scope")) {
    scope = (await run.readJson<Scope>("scope.json"))!;
    say("resuming: scope already settled");
  } else {
    const roles = resolveRoles(readRoleConfig(), opts.fallbackModel);
    say("working out what to ask you…");
    const { draft } = await draftScope({
      question: opts.question,
      model: roles.analyst,
      ...(opts.signal ? { signal: opts.signal } : {}),
      cwd,
      onDelta: stream("scoping"),
    });

    const answers = new Map<ScopeQuestion, string>();
    for (const [i, q] of draft.questions.entries()) {
      // Announce the dialog before blocking on it: if the app cannot show it,
      // the conversation says what it is waiting for instead of going quiet.
      say(`question ${i + 1}/${draft.questions.length}: ${q.ask}`);
      const answer = await ui.input(q.ask, "Enter to skip");
      // Cancelling the dialog ends the run; skipping one question does not.
      if (answer === undefined) throw new CancelledError("scoping cancelled");
      answers.set(q, answer);
    }
    scope = applyAnswers(draft, opts.question, answers);
    await run.writeJson("scope.json", scope);
  }

  /* ---------------- 2. plan ---------------- */

  checkpoint("plan");
  let plan: Plan;
  if (run.isDone("plan")) {
    plan = (await run.readJson<Plan>("plan.json"))!;
    say(`resuming: plan already approved (${plan.queries.length} queries)`);
  } else {
    const roles = resolveRoles(readRoleConfig(), opts.fallbackModel);
    const config = readRoleConfig();
    say("drafting the plan…");
    const { queries } = await generateQueries({
      scope,
      model: roles.analyst,
      ...(opts.signal ? { signal: opts.signal } : {}),
      cwd,
      onDelta: stream("planning"),
    });

    const proposed: Plan = {
      scope,
      category: effectiveCategory(undefined, "science"),
      queries,
      pages: 2,
      screenTop: 150,
      fullTexts: 30,
      roles,
      // Settings owns the embeddings endpoint, so its model is the default;
      // the saved role assignment only fills in when Settings has none.
      ...(readResearchConfig().embeddings?.model ?? config.embedModel
        ? { embedModel: readResearchConfig().embeddings?.model ?? config.embedModel! }
        : {}),
    };

    const edited = await ui.editor("Research plan — edit anything, then save", renderPlan(proposed));
    if (edited === undefined) throw new CancelledError("plan not approved");
    // Parsed strictly: a typo'd model must fail here, not forty minutes in.
    plan = parsePlan(edited, proposed, opts.knownModels);
    await run.writeJson("plan.json", plan);
    await run.write("plan.md", renderPlan(plan));
  }

  /* ---------------- 3. discover ---------------- */

  checkpoint("discover");
  if (!run.isDone("discover")) {
    const seen = new Set<string>();
    const hits: SearchHit[] = [];
    for (const [i, query] of plan.queries.entries()) {
      for (let page = 1; page <= plan.pages; page++) {
        checkpoint("discover");
        say(`searching ${i + 1}/${plan.queries.length} (page ${page}): ${query}`);
        try {
          const found = dedupe(
            await searxng(query, {
              categories: plan.category,
              page,
              ...(opts.signal ? { signal: opts.signal } : {}),
            }),
          );
          let fresh = 0;
          for (const hit of found) {
            const key = canonicalUrl(hit.url ?? "");
            if (!key || seen.has(key)) continue;
            seen.add(key);
            hits.push(hit);
            fresh++;
          }
          await run.logSearch({
            query, source: "searxng", category: plan.category, page,
            results: found.length, newResults: fresh,
          });
          if (found.length === 0) break; // no more pages for this query
        } catch (err) {
          // One dead query must not sink the sweep.
          await run.logSearch({
            query, source: "searxng", category: plan.category, page, results: 0,
            error: (err as Error).message,
          });
        }
      }
    }

    let hydrated: Hydrated[] = [];
    if (await isScholarlyCategory(plan.category, opts.signal)) {
      say(`identifying ${hits.length} results in OpenAlex…`);
      hydrated = await hydrateHits(hits, opts.signal, (n, total) =>
        say(`identified ${n}/${total}`),
      );
    }

    for (const [i, hit] of hits.entries()) {
      const h = hydrated[i];
      await run.appendPartial("candidates.jsonl", {
        id: i + 1,
        url: hit.url,
        title: hit.title,
        dedupeKey: canonicalUrl(hit.url ?? ""),
        engine: hit.engine,
        abstract: h?.abstract ?? hit.content,
        ...(h?.year ? { year: h.year } : {}),
        ...(h?.venue ? { venue: h.venue } : {}),
        ...(h?.doi ? { doi: h.doi } : {}),
        ...(h?.authors ? { authors: h.authors } : {}),
        ...(h?.citedBy !== undefined ? { citedBy: h.citedBy } : {}),
        ...(h?.pdfUrl ? { pdfUrl: h.pdfUrl } : {}),
        ...(h?.note ? { note: h.note } : {}),
      });
    }
    await run.finalize("candidates.jsonl");
    say(`${hits.length} candidates found`);
  }

  interface StoredCandidate extends Candidate {
    pdfUrl?: string;
    authors?: string[];
    note?: string;
  }
  const candidates = await run.readJsonl<StoredCandidate>("candidates.jsonl");
  if (candidates.length === 0) {
    throw new Error(
      "no candidates found — check that SearXNG is running and the category has engines behind it",
    );
  }

  /* ---------------- 4. screen ---------------- */

  checkpoint("screen");
  if (!run.isDone("screen")) {
    let shortlist = candidates;

    if (plan.embedModel) {
      say(`ranking ${candidates.length} candidates by similarity…`);
      // The dedicated embeddings endpoint when one is configured; the chat
      // provider only when the same server happens to serve both.
      const configured = configuredEmbeddingEndpoint();
      const endpoint = configured ?? resolveEndpoint();
      const texts = candidates.map((c) => `${c.title}\n${c.abstract ?? ""}`.slice(0, 4_000));
      const vectors = await embedTexts(texts, plan.embedModel, endpoint, opts.signal, (d, t) =>
        say(`embedded ${d}/${t}`),
      );
      const [query] = await embedTexts(
        [[scope.question, ...scope.subQuestions].join("\n")],
        plan.embedModel,
        endpoint,
        opts.signal,
      );
      shortlist = rankBySimilarity(candidates, vectors, query!)
        .slice(0, plan.screenTop)
        .map((r) => r.item);
      await run.append("ranking.jsonl", { ranked: candidates.length, kept: shortlist.length });
    } else {
      shortlist = candidates.slice(0, plan.screenTop);
    }

    say(`screening ${shortlist.length} candidates…`);
    const { decisions } = await screenCandidates({
      scope: { question: scope.question, include: scope.include, exclude: scope.exclude },
      candidates: shortlist,
      model: plan.roles.screener,
      rubric: await rubricPath("screening"),
      ...(opts.signal ? { signal: opts.signal } : {}),
      cwd,
      onBatch: (n, of, from, to) =>
        say(`screening batch ${n}/${of} — candidates ${from}–${to} of ${shortlist.length}`),
      onProgress: (d, t) => say(`screened ${d}/${t}`),
      onDelta: stream("screening"),
    });
    for (const d of decisions) await run.appendPartial("screened.jsonl", d);
    await run.finalize("screened.jsonl");
  }

  const decisions = await run.readJsonl<Decision>("screened.jsonl");
  const included = decisions.filter((d) => d.include);
  if (included.length === 0) {
    throw new Error("screening excluded every candidate — the criteria in the plan may be too narrow");
  }

  /* ---------------- 5. retrieve ---------------- */

  checkpoint("retrieve");
  if (!run.isDone("retrieve")) {
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const wanted = included
      .map((d) => byId.get(d.id))
      .filter((c): c is StoredCandidate => !!c)
      .slice(0, plan.fullTexts);

    say(`reading ${wanted.length} sources in full…`);
    let done = 0;
    const pages = await pooled(wanted, FETCH_CONCURRENCY, async (c) => {
      // An open-access PDF is the full text; the search hit is often a stub.
      const page = await fetchPage(c.pdfUrl ?? c.url, 60_000, opts.signal);
      say(`read ${++done}/${wanted.length}`);
      return page;
    });

    let n = 0;
    for (const [i, page] of pages.entries()) {
      const c = wanted[i]!;
      // A source that could not be read still gets a record, from its abstract,
      // so the run reports "abstract only" rather than losing the paper.
      const text = page.error || !page.text ? (c.abstract ?? "") : page.text;
      if (!text.trim()) continue;
      const record = makeSourceRecord(++n, text, {
        url: page.error ? c.url : page.url,
        title: c.title,
        via: page.error || !page.text ? "abstract" : page.via,
        ...(c.authors ? { authors: c.authors } : {}),
        ...(c.year ? { year: c.year } : {}),
        ...(c.venue ? { venue: c.venue } : {}),
        ...(c.doi ? { doi: c.doi } : {}),
        ...(c.note ? { note: c.note } : {}),
      });
      await run.saveSource(record, text);
    }
  }

  const sources = await run.sources();
  if (sources.length === 0) throw new Error("no sources could be read");

  /* ---------------- 6. extract ---------------- */

  checkpoint("extract");
  if (!run.isDone("extract")) {
    const texts = await run.sourceTexts();
    for (const [i, source] of sources.entries()) {
      checkpoint("extract");
      say(`extracting passages ${i + 1}/${sources.length}: ${source.title.slice(0, 50)}`);
      const text = texts.get(source.n);
      if (!text) continue;
      const { claims, dropped } = await extractFromSource({
        sourceNumber: source.n,
        title: source.title,
        text,
        questions: scope.subQuestions,
        model: plan.roles.analyst,
        rubric: await rubricPath("extraction"),
        ...(opts.signal ? { signal: opts.signal } : {}),
        cwd,
        onDelta: stream(`extracting [${source.n}]`),
      });
      for (const c of claims) await run.appendPartial("claims.jsonl", c);
      for (const d of dropped) await run.append("dropped-claims.jsonl", d);
    }
    // Finalising is what marks the stage done, and it writes an empty file when
    // nothing was extracted — otherwise a resumed run repeats every call.
    await run.finalize("claims.jsonl");
  }

  const claims = await run.readJsonl<Claim>("claims.jsonl");
  if (claims.length === 0) {
    throw new Error("no passages could be located in any source — nothing to write a report from");
  }

  /* ---------------- 7. synthesize ---------------- */

  checkpoint("synthesize");
  if (!run.isDone("synthesize")) {
    say(`writing the report from ${claims.length} located passages…`);
    const { draft } = await synthesize({
      input: { question: scope.question, subQuestions: scope.subQuestions, claims, sources },
      model: plan.roles.synthesist,
      ...(opts.signal ? { signal: opts.signal } : {}),
      cwd,
      onDelta: stream("writing"),
    });
    await run.write("draft.md", draft);
  }
  const draft = (await run.readText("draft.md"))!;

  /* ---------------- 8. verify ---------------- */

  checkpoint("verify");
  if (!run.isDone("verify")) {
    say("checking every citation against its passage…");
    const { checks } = await verifyDraft({
      draft,
      claims,
      model: plan.roles.analyst,
      ...(opts.signal ? { signal: opts.signal } : {}),
      cwd,
      onBatch: (n, of) => say(`checking citations, batch ${n}/${of}`),
      onProgress: (d, t) => say(`verified ${d}/${t}`),
      onDelta: stream("verifying"),
    });
    for (const c of checks) await run.appendPartial("verification.jsonl", c);
    await run.finalize("verification.jsonl");
  }
  const checks = await run.readJsonl<Check>("verification.jsonl");
  const flagged = checks.filter((c) => c.verdict !== "supports");

  /* ---------------- 9. review ---------------- */

  checkpoint("review");
  if (!run.isDone("review")) {
    say(`reviewing the draft with ${plan.roles.reviewer}…`);
    const { review } = await reviewDraft({
      question: scope.question,
      draft,
      checks,
      flagged,
      model: plan.roles.reviewer,
      rubric: await rubricPath("review"),
      ...(opts.signal ? { signal: opts.signal } : {}),
      cwd,
      onDelta: stream("reviewing"),
    });
    await run.write("review.md", review);
  }
  const review = (await run.readText("review.md"))!;

  /* ---------------- 10. revise ---------------- */

  checkpoint("revise");
  if (!run.isDone("revise")) {
    say("revising against the critique…");
    const { report } = await reviseDraft({
      question: scope.question,
      draft,
      review,
      flagged,
      sources,
      model: plan.roles.synthesist,
      ...(opts.signal ? { signal: opts.signal } : {}),
      cwd,
      onDelta: stream("revising"),
    });
    await run.write("report.md", report);
  }

  const report = (await run.readText("report.md"))!;
  const bibliography = renderBibliography(sources);
  await run.write("report-final.md", [report, "", "## Sources", "", bibliography, ""].join("\n"));

  return {
    report,
    bibliography,
    // Handed out so the GUI can turn each [n] in the report into a link. This
    // is the same table the citation audit ran against, never model output.
    sources,
    funnel: await run.funnel(),
    summary: await run.summary(),
  };
}
