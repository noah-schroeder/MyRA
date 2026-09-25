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
import { DATABASES, DEFAULT_DATABASES, type DatabaseInfo } from "./databases.ts";
import { hasDatabaseKey } from "./keys.ts";
import { isScholarlyCategory, resolveProviders, search, workToHit } from "./providers.ts";
import { dedupe, type SearchHit } from "./types.ts";
import { canonicalUrl } from "./html.ts";
import { fromWork, hydrateHits, type Hydrated } from "./hydrate.ts";
import { fetchPage, pooled } from "./fetch.ts";
import { FETCH_CONCURRENCY } from "./config.ts";
import { embedTexts, embeddingEndpoint, rankBySimilarity } from "./embed.ts";
import { fairShortlist, screenCandidates, type Candidate, type Decision } from "./screen.ts";
import { extractFromSource, type Claim } from "./extract.ts";
import { synthesize } from "./synthesize.ts";
import { verifyDraft, type Check } from "./verify.ts";
import { reviewDraft, reviseDraft } from "./review.ts";
import { makeSourceRecord, renderBibliography, verifyQuotes, type SourceRecord } from "./sources.ts";
import { generateQueries, parsePlan, renderPlan, type Plan } from "./plan.ts";
import { applyAnswers, draftScope, type Scope, type ScopeQuestion } from "./scope.ts";
import { rubricText } from "./rubrics.ts";
import { collapseDuplicates, identityKey, type Dedupable } from "./dedupe.ts";
import { openAlexByDoi, openAlexByIds } from "./openalex.ts";
import { coCitationThreshold, coCitedWorks } from "./snowball.ts";
import { toBibtex, toCslJson } from "./export.ts";
import { readRoleConfig, resolveRoles, writeRoleConfig } from "./roles.ts";
import {
  applyRoleAnswer, databaseChoice, databasesFromAnswer, defaultDepth, DEPTH_PRESETS,
  depthFromLabel, depthFromText, depthLabel, embedderChoice, EMBEDDER_SLOT, ROLE_SLOTS,
  SAME_MODEL_QUESTION, SINGLE_SLOT, wantsSeparateModels, type Choice, type RoleSlot,
} from "./questions.ts";
import type { ResearchRun } from "./run.ts";

export interface InputExtra {
  prefill?: string | undefined;
  /** A line under the title: where a prefilled answer came from. */
  message?: string | undefined;
}

/** Just the dialog surface the pipeline needs, so it can be run headless in tests. */
export interface PipelineUi {
  /**
   * A line of text. `placeholder` is the grey hint; `prefill` is a real answer
   * already in the box, which the person keeps by pressing Enter. The two were
   * once the same argument, and "Enter to skip" arrived typed into the box.
   */
  input(title: string, placeholder?: string, extra?: InputExtra): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  /**
   * A question with answers to pick from.
   *
   * The app adds "Other" and a skip; this only carries what the question is
   * and what the likely answers are. Returns the chosen text -- several
   * answers joined by `JOIN` when `multi` -- or undefined for skipped.
   */
  choose?(choice: Choice): Promise<string | undefined>;
  /** One dropdown per role, grouped by where the model runs. JSON back. */
  models?(slots: readonly RoleSlot[], current: Record<string, string>): Promise<Record<string, string> | undefined>;
  notify?(message: string, type?: "info" | "warning" | "error"): void;
}

export interface PipelineOptions {
  question: string;
  run: ResearchRun;
  /**
   * Forces the category for this run, overriding the GUI setting.
   *
   * This is how `academic_research` means what its name says: the tool the
   * model chose decides, not whatever the settings happened to hold when the
   * user last touched them.
   */
  category?: string;
  /** The model the app's dropdown is on: the first-run fallback for every role. */
  fallbackModel: string;
  ui: PipelineUi;
  knownModels?: string[];
  signal?: AbortSignal;
  onProgress?: (note: string) => void;
  /**
   * Which stage has just started.
   *
   * Separate from `onProgress`, which carries a detail line that changes many
   * times a second within one stage. This fires once per stage, so the window
   * can show the run as a sequence with a position in it rather than as a
   * single line that keeps changing.
   */
  onStage?: (stage: string) => void;
  /**
   * The notes of the research project this run belongs to, for scoping only --
   * the one stage whose every output a person confirms before anything runs.
   * No later stage sees them: a screening or synthesis prompt steered by
   * project notes is the unguarded path CLAUDE.md's memory rule exists for.
   */
  projectNotes?: string | undefined;
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
  /*
   * Alive, and never the model's own words.
   *
   * This line sits above the composer in the main window for the whole run, so
   * whatever it holds is the app's most prominent text. Showing the tail of the
   * stream put raw model output there, and a stage whose output is JSON put its
   * monologue about JSON formatting there -- "I must not include any text
   * outside the JSON. Let's finalize the JSON content. subQuestions: [" --
   * which reads as a malfunction rather than as progress. Reported as one.
   *
   * A climbing word count answers the only question a status line is for:
   * whether anything is still happening. It cannot leak reasoning, cannot leak
   * a half-formed structure, and cannot suddenly become five lines tall.
   */
  const stream = (label: string) => {
    let words = 0;
    let last = 0;
    return (delta: string, kind: "text" | "thinking"): void => {
      words += (delta.match(/\S+/g) ?? []).length;
      const now = Date.now();
      if (now - last < 500) return;
      last = now;
      say(`${label}${kind === "thinking" ? " (thinking)" : ""}… ${words.toLocaleString()} words`);
    };
  };
  const cwd = run.path();

  /** Called at every stage boundary — the only place a pause can be honoured. */
  let announced: string | undefined;
  const checkpoint = (stage: string): void => {
    if (opts.signal?.aborted) throw new CancelledError("research cancelled");
    if (run.isPaused()) throw new PausedError(run.id, stage);
    /* Announced from here because this is the one call every stage already
       makes, so a new stage cannot be added without the window learning about
       it. Some stages checkpoint on every item, hence the guard. */
    if (stage !== announced) {
      announced = stage;
      opts.onStage?.(stage);
    }
  };

  /* ---------------- 1. scope ---------------- */

  checkpoint("scope");
  let scope: Scope;
  if (run.isDone("scope")) {
    scope = (await run.readJson<Scope>("scope.json"))!;
    say("resuming: scope already settled");
  } else {
    const roles = resolveRoles(readRoleConfig(), opts.fallbackModel);
    say(opts.projectNotes?.trim() ? "working out what to ask you, from the question and this project's notes…" : "working out what to ask you…");
    if (opts.projectNotes?.trim()) {
      /* Kept with the run, because the run directory is the audit trail: a
         scope that came partly from project notes should say which notes. */
      await run.write("project-notes.md", `${opts.projectNotes.trim()}\n`);
    }
    const { draft } = await draftScope({
      question: opts.question,
      model: roles.analyst,
      ...(opts.signal ? { signal: opts.signal } : {}),
      cwd,
      onDelta: stream("scoping"),
      ...(opts.projectNotes?.trim() ? { projectNotes: opts.projectNotes } : {}),
    });

    const answers = new Map<ScopeQuestion, string>();
    for (const [i, q] of draft.questions.entries()) {
      // Announce the dialog before blocking on it: if the app cannot show it,
      // the conversation says what it is waiting for instead of going quiet.
      say(`question ${i + 1}/${draft.questions.length}: ${q.ask}`);
      /* Options when the model proposed any, a blank box when it did not.
         The fallback is not a failure mode: some questions are genuinely open,
         and a small scoping model that cannot propose good answers should
         degrade to the box rather than to two bad options. */
      const answer =
        q.options.length && ui.choose
          ? await ui.choose({ title: q.ask, options: q.options, ...(q.multi ? { multi: true } : {}) })
          : await ui.input(q.ask, "Enter to skip");
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
    // Read once, here, so a missing embeddings endpoint is visible in the plan
    // the user approves rather than discovered as a silently skipped stage.
    const embeddings = await embeddingEndpoint().catch(() => undefined);
    say("drafting the plan…");
    const { queries } = await generateQueries({
      scope,
      model: roles.analyst,
      ...(opts.signal ? { signal: opts.signal } : {}),
      cwd,
      onDelta: stream("planning"),
    });

    /*
     * How deep, asked rather than defaulted.
     *
     * These were four numbers in the plan document. They are a fair way to
     * store the decision and a poor way to make it: nobody picks 150 over 250
     * from a blank field, and what is really being chosen is how long the run
     * takes against how much it misses. The numbers are still in the labels,
     * and still editable in the plan afterwards.
     */
    const fallbackDepth = defaultDepth();
    let depth = fallbackDepth;
    if (ui.choose) {
      const answer = await ui.choose({
        title: "How thorough should this run be?",
        message:
          "Each step up roughly doubles the time and the cost. Nothing here is fixed — " +
          "you can change any of it in the plan on the next screen.",
        options: DEPTH_PRESETS.map(depthLabel),
      });
      if (answer === undefined) throw new CancelledError("plan not approved");
      depth = answer.trim() ? depthFromLabel(answer) ?? depthFromText(answer, fallbackDepth) : fallbackDepth;
    }

    /*
     * Which databases, asked here because this is where the answer lives --
     * on the plan, not the scope (see Scope.include, which a database name
     * must never land in: it is fed verbatim to the screener).
     *
     * Only databases with a key already entered are offered, and the answer
     * is required: a database nobody can search must not appear in a
     * question the run cannot get past, and a run that searched nothing
     * because every box was left unticked would look like a bug forty
     * minutes later rather than an unanswered question.
     */
    const usable: DatabaseInfo[] = [];
    for (const d of DATABASES) {
      if (!d.secret || (await hasDatabaseKey(d.secret))) usable.push(d);
    }
    const storedDatabases = readResearchConfig().databases;
    let chosenDatabases: string[] = storedDatabases?.length ? storedDatabases : [...DEFAULT_DATABASES];
    if (ui.choose && usable.length) {
      const answer = await ui.choose(databaseChoice(usable));
      if (answer === undefined) throw new CancelledError("plan not approved");
      const picked = databasesFromAnswer(answer);
      if (picked.length) chosenDatabases = picked;
    }
    // Never propose a database with no key, however it was chosen before.
    chosenDatabases = chosenDatabases.filter((id) => usable.some((d) => d.id === id));
    // The keyless pair, not merely "the first usable one" -- DEFAULT_DATABASES
    // exists precisely to be the sensible fallback when every previously
    // chosen database has since lost its key (e.g. a stored choice of just
    // "pubmed" whose ncbiKey was removed), and it is always reachable since
    // OpenAlex and arXiv need no key at all.
    if (chosenDatabases.length === 0) chosenDatabases = [...DEFAULT_DATABASES];

    /*
     * And who does the work, always asked, always last.
     *
     * The self-review warning existed already, as a blockquote inside a
     * markdown document somebody had to read. A question asked before the run
     * is the same fact where it can be acted on.
     */
    let chosenRoles = roles;
    /* Settings owns the embeddings ENDPOINT, so its model is what the dialog
       opens on; the saved role assignment only fills in when Settings has
       none. */
    let chosenEmbed = embeddings?.model ?? config.embedModel;
    if (ui.choose && ui.models) {
      const same = await ui.choose(SAME_MODEL_QUESTION);
      if (same === undefined) throw new CancelledError("plan not approved");
      /* The embedder is appended to BOTH answers. It is not a chat model, so
         "one model for everything" cannot cover it -- and leaving it out of
         the one-model branch is what used to send people to Settings for the
         single stage they had no way of knowing was there. */
      const slots = [...(wantsSeparateModels(same) ? ROLE_SLOTS : [SINGLE_SLOT]), EMBEDDER_SLOT];
      const picked = await ui.models(slots, {
        ...roles,
        all: roles.synthesist,
        ...(chosenEmbed ? { embedder: chosenEmbed } : {}),
      });
      if (picked === undefined) throw new CancelledError("plan not approved");
      chosenRoles = applyRoleAnswer(roles, picked);
      chosenEmbed = embedderChoice(picked, chosenEmbed);
    }

    const proposed: Plan = {
      scope,
      category: opts.category ?? effectiveCategory(undefined, "science"),
      databases: chosenDatabases,
      queries,
      pages: depth.pages,
      screenTop: depth.screenTop,
      fullTexts: depth.fullTexts,
      snowball: depth.snowball,
      roles: chosenRoles,
      ...(chosenEmbed ? { embedModel: chosenEmbed } : {}),
    };

    const edited = await ui.editor("Research plan — edit anything, then save", renderPlan(proposed));
    if (edited === undefined) throw new CancelledError("plan not approved");
    // Parsed strictly: a typo'd model must fail here, not forty minutes in.
    plan = parsePlan(edited, proposed, opts.knownModels);
    /*
     * Remember the roles you chose, so the next run starts from them.
     *
     * Without this the plan editor was write-only: you could name a separate
     * reviewer, the run would honour it, and the next run would silently reset
     * every role to the app's current model -- which is self-review again. The
     * warning about that is only actionable if acting on it sticks.
     */
    await writeRoleConfig({
      models: { ...plan.roles },
      ...(plan.embedModel ? { embedModel: plan.embedModel } : {}),
    }).catch(() => undefined);
    await run.writeJson("plan.json", plan);
    await run.write("plan.md", renderPlan(plan));
  }

  /* ---------------- 3. discover ---------------- */

  checkpoint("discover");
  if (!run.isDone("discover")) {
    const { providers: chosenProviders, unavailable } = await resolveProviders(plan.databases);
    say(`searching ${chosenProviders.map((p) => p.label).join(", ")}`);
    // A run whose recall silently halved because a key went missing between
    // the plan step and now must say so in its own log -- the same reason a
    // dead search backend is logged rather than swallowed, below.
    for (const label of unavailable) say(`${label} skipped — no API key is stored for it`);
    const seen = new Set<string>();
    /*
     * Which query found each hit, carried alongside it.
     *
     * Needed by screening: without an embeddings model the shortlist is a
     * truncation, and a truncation of a list built query-by-query throws away
     * whole queries -- the last two or three in the plan are never screened at
     * all. Recording the query is what lets that truncation be fair instead.
     */
    const hits: { hit: SearchHit; query: number }[] = [];
    for (const [i, query] of plan.queries.entries()) {
      for (let page = 1; page <= plan.pages; page++) {
        checkpoint("discover");
        say(`searching ${i + 1}/${plan.queries.length} (page ${page}): ${query}`);
        try {
          const outcome = await search(query, {
            categories: plan.category,
            page,
            providers: chosenProviders,
            ...(opts.signal ? { signal: opts.signal } : {}),
          });
          /* A run that swept half the literature because a backend was down
             must say so in its own log: this file is the audit trail, and a
             report whose recall silently halved is exactly the thing it
             exists to make visible. */
          for (const failure of outcome.failures) say(`search backend unavailable — ${failure}`);
          const found = dedupe(outcome.hits);
          let fresh = 0;
          for (const hit of found) {
            const key = canonicalUrl(hit.url ?? "");
            if (!key || seen.has(key)) continue;
            seen.add(key);
            hits.push({ hit, query: i });
            fresh++;
          }
          await run.logSearch({
            query, source: "search", category: plan.category, page,
            results: found.length, newResults: fresh,
          });
          if (found.length === 0) break; // no more pages for this query
        } catch (err) {
          // One dead query must not sink the sweep.
          await run.logSearch({
            query, source: "search", category: plan.category, page, results: 0,
            error: (err as Error).message,
          });
        }
      }
    }

    let hydrated: Hydrated[] = [];
    if (isScholarlyCategory(plan.category)) {
      say(`identifying ${hits.length} results in OpenAlex…`);
      hydrated = await hydrateHits(hits.map((h) => h.hit), opts.signal, (n, total) =>
        say(`identified ${n}/${total}`),
      );
    }

    /*
     * Collapse the same paper found twice, now that hydration has supplied the
     * DOIs. Discovery could only dedupe by URL, which misses both of the cases
     * these providers produce constantly: the arXiv PDF and the OpenAlex record
     * of one preprint, and a preprint alongside its published version.
     */
    interface Row extends Dedupable {
      engine?: string;
      foundBy: number;
      authors?: string[];
    }
    const rows: Row[] = hits.map(({ hit, query }, i) => {
      const h = hydrated[i];
      return {
        id: i + 1,
        url: hit.url,
        title: hit.title,
        foundBy: query,
        abstract: h?.abstract ?? hit.content,
        ...(hit.engine ? { engine: hit.engine } : {}),
        ...(h?.year ? { year: h.year } : {}),
        ...(h?.venue ? { venue: h.venue } : {}),
        ...(h?.doi ? { doi: h.doi } : {}),
        ...(h?.authors ? { authors: h.authors } : {}),
        ...(h?.citedBy !== undefined ? { citedBy: h.citedBy } : {}),
        ...(h?.pdfUrl ? { pdfUrl: h.pdfUrl } : {}),
        ...(h?.note ? { note: h.note } : {}),
      };
    });

    const { rows: unique, merged } = collapseDuplicates(rows);
    for (const m of merged) await run.append("merged.jsonl", m);
    if (merged.length) {
      say(`${merged.length} duplicate record(s) collapsed into the paper they duplicate`);
    }

    // Ids are assigned AFTER collapsing, so a citation number always refers to
    // one paper and the numbers have no gaps.
    for (const [i, row] of unique.entries()) {
      const { id: _discard, ...rest } = row as Row & { id: number };
      await run.appendPartial("candidates.jsonl", {
        ...rest,
        id: i + 1,
        dedupeKey: identityKey(row),
      });
    }
    await run.finalize("candidates.jsonl");
    say(`${unique.length} candidates found`);
  }

  interface StoredCandidate extends Candidate {
    pdfUrl?: string;
    authors?: string[];
    note?: string;
    /** Index of the plan query that surfaced this candidate. */
    foundBy?: number;
  }
  const candidates = await run.readJsonl<StoredCandidate>("candidates.jsonl");
  if (candidates.length === 0) {
    throw new Error(
      "no candidates found — no provider returned results for this category",
    );
  }

  /* ---------------- 4. screen ---------------- */

  checkpoint("screen");
  if (!run.isDone("screen")) {
    let shortlist = candidates;

    const endpoint = plan.embedModel ? await embeddingEndpoint() : undefined;
    if (plan.embedModel && endpoint) {
      say(`ranking ${candidates.length} candidates by similarity…`);
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
      // No embeddings model, so there is no ranking to apply -- but a flat
      // truncation would drop the plan's later queries entirely. Take from
      // every query in turn instead. See fairShortlist.
      shortlist = fairShortlist(candidates, plan.screenTop);
      if (shortlist.length < candidates.length) {
        say(
          `no embeddings model configured — screening ${shortlist.length} of ` +
            `${candidates.length}, taken evenly across all ${plan.queries.length} queries`,
        );
        await run.append("ranking.jsonl", {
          ranked: candidates.length,
          kept: shortlist.length,
          method: "round-robin across queries (no embeddings model configured)",
        });
      }
    }

    say(`screening ${shortlist.length} candidates…`);
    const { decisions } = await screenCandidates({
      scope: { question: scope.question, include: scope.include, exclude: scope.exclude },
      candidates: shortlist,
      model: plan.roles.screener,
      rubric: await rubricText("screening"),
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

  /* ---------------- 5. snowball ---------------- */

  /*
   * Backward citation-graph traversal.
   *
   * Keyword search finds papers whose TITLE uses the vocabulary you searched
   * for. The foundational paper a literature is built on usually does not: it
   * was written before the field settled on those words, and it surfaces only
   * because everyone cites it. `referenced_works` was already being fetched on
   * every hit and only its LENGTH was ever used.
   *
   * The co-citation threshold is what keeps this affordable and what makes it
   * good. Forty included papers cite perhaps two thousand works between them;
   * taking all of them would swamp screening with one-off references. Taking
   * only what SEVERAL included papers cite surfaces the shared ancestry of the
   * literature, which is exactly what a review wants.
   */
  checkpoint("snowball");
  if (!run.isDone("snowball")) {
    if (plan.snowball < 1) {
      await run.finalize("snowball.jsonl"); // writes empty: the stage is done
    } else {
      const byId = new Map(candidates.map((c) => [c.id, c]));
      const seen = new Set(candidates.map((c) => identityKey(c as Dedupable)));
      let seeds = included.map((d) => byId.get(d.id)).filter((c): c is StoredCandidate => !!c);
      let nextId = candidates.length;

      for (let round = 1; round <= plan.snowball; round++) {
        checkpoint("snowball");
        const withDoi = seeds.filter((c) => c.doi);
        say(`snowball round ${round}: reading references of ${withDoi.length} paper(s)…`);

        /* The single-entity DOI lookup is unmetered, so collecting references
         * for every seed costs nothing against the daily credit budget. */
        let read = 0;
        const works = await pooled(withDoi, FETCH_CONCURRENCY, async (c) => {
          const work = await openAlexByDoi(c.doi!, opts.signal).catch(() => undefined);
          say(`snowball round ${round}: ${++read}/${withDoi.length}`);
          return work;
        });

        const threshold = coCitationThreshold(withDoi.length);
        const wanted = coCitedWorks(
          works.map((w) => w?.referenced_works),
          { threshold, limit: plan.screenTop },
        ).map((c) => c.id);

        if (wanted.length === 0) {
          say(`snowball round ${round}: nothing was cited by ${threshold} or more papers`);
          break;
        }

        say(`snowball round ${round}: fetching ${wanted.length} co-cited work(s)…`);
        const found = await openAlexByIds(wanted, opts.signal);
        const fresh: StoredCandidate[] = [];
        for (const work of found) {
          const hit = workToHit(work);
          if (!hit) continue;
          const row: Dedupable = {
            id: 0, url: hit.url, title: hit.title,
            ...(work.doi ? { doi: work.doi } : {}),
          };
          const key = identityKey(row);
          if (seen.has(key)) continue; // already a candidate from the sweep
          seen.add(key);
          const h = fromWork(work, "provider");
          fresh.push({
            id: ++nextId,
            url: hit.url,
            title: hit.title,
            abstract: h.abstract ?? hit.content,
            ...(h.year ? { year: h.year } : {}),
            ...(h.venue ? { venue: h.venue } : {}),
            ...(h.doi ? { doi: h.doi } : {}),
            ...(h.authors ? { authors: h.authors } : {}),
            ...(h.citedBy !== undefined ? { citedBy: h.citedBy } : {}),
            ...(h.pdfUrl ? { pdfUrl: h.pdfUrl } : {}),
            ...(h.note ? { note: h.note } : {}),
          });
        }

        if (fresh.length === 0) {
          say(`snowball round ${round}: every co-cited work was already a candidate`);
          break;
        }

        say(`snowball round ${round}: screening ${fresh.length} new candidate(s)…`);
        const { decisions: more } = await screenCandidates({
          scope: { question: scope.question, include: scope.include, exclude: scope.exclude },
          candidates: fresh,
          model: plan.roles.screener,
          rubric: await rubricText("screening"),
          ...(opts.signal ? { signal: opts.signal } : {}),
          cwd,
          onProgress: (d, t) => say(`snowball round ${round}: screened ${d}/${t}`),
          onDelta: stream("screening (snowball)"),
        });

        for (const c of fresh) await run.appendPartial("snowball.jsonl", { ...c, round });
        for (const d of more) await run.append("screened-snowball.jsonl", { ...d, round });

        seeds = fresh.filter((c) => more.find((d) => d.id === c.id)?.include);
        say(`snowball round ${round}: ${seeds.length} of ${fresh.length} kept`);
        if (seeds.length === 0) break;
      }
      await run.finalize("snowball.jsonl");
    }
  }

  /* Snowballed papers are candidates and decisions like any others from here
   * on -- the only difference is how they were found. */
  const snowballed = await run.readJsonl<StoredCandidate>("snowball.jsonl");
  const snowballDecisions = await run.readJsonl<Decision>("screened-snowball.jsonl");
  const allCandidates = [...candidates, ...snowballed];
  const allIncluded = [...included, ...snowballDecisions.filter((d) => d.include)];

  /* ---------------- 6. retrieve ---------------- */

  checkpoint("retrieve");
  if (!run.isDone("retrieve")) {
    const byId = new Map(allCandidates.map((c) => [c.id, c]));
    const wanted = allIncluded
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
        rubric: await rubricText("extraction"),
        ...(opts.signal ? { signal: opts.signal } : {}),
        cwd,
        // A long paper is read in parts now, so say which part: a source that
        // takes four calls otherwise looks like a stalled one.
        onChunk: (n, of) =>
          of > 1 ? say(`extracting [${source.n}] part ${n}/${of}: ${source.title.slice(0, 40)}`) : undefined,
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
      rubric: await rubricText("review"),
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

  /* ------------- the finished report's quotes, checked mechanically -------- */

  /*
   * Extraction proved every quote was verbatim in its source. That was two
   * model calls ago: synthesis wrote the sentences and revision rewrote them,
   * and both are free to reshape a quotation while keeping the quote marks.
   * verifyQuotes existed for this from the start and the pipeline never called
   * it, so the guarantee stopped at the claims table and the REPORT -- the only
   * artefact anyone reads -- was never checked at all.
   *
   * This is a mechanical check, not a judgement: a quote either appears in the
   * stored source text or it does not.
   */
  const quoteChecks = verifyQuotes(report, sources, await run.sourceTexts());
  const badQuotes = quoteChecks.filter((q) => !q.verbatim);
  if (quoteChecks.length) {
    await run.write("quote-checks.jsonl", quoteChecks.map((q) => JSON.stringify(q)).join("\n") + "\n");
  }
  if (badQuotes.length) {
    say(`${badQuotes.length} quotation(s) in the report are not verbatim in the source they cite`);
    ui.notify?.(
      `${badQuotes.length} quotation(s) in the final report could not be found verbatim ` +
        `in the source cited. See the run's quote-checks.jsonl.`,
      "warning",
    );
  }

  const bibliography = renderBibliography(sources);
  await run.write("report-final.md", [report, "", "## Sources", "", bibliography, ""].join("\n"));
  // Rendered from the source table like the bibliography, never from model
  // output. A report you cannot get into Zotero is a report you retype, and
  // retyping is where citations drift.
  await run.write("sources.bib", toBibtex(sources));
  await run.write("sources.json", toCslJson(sources));

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
