/**
 * Searching the model registry, with the country always on screen.
 *
 * The requirement this is built around is not "let people search a registry".
 * It is that a researcher whose institution restricts where models may come
 * from can tell, at a glance and without knowing who runs what, exactly where
 * a result came from. Hence:
 *
 *   - The registry is named `Hugging Face [US]` in the header, in the bar, in
 *     the status line and on every result row. The country is in the label,
 *     not in a tooltip.
 *   - Nothing is searched until the search is run. Typing sends nothing:
 *     **the query itself is egress**, and a search-as-you-type box would post
 *     fragments of a person's words to a remote service on every keystroke.
 *     That is why this searches on Enter, not on change.
 *   - The sentence under the box says, in plain words, where the text is about
 *     to be sent -- while it still has not been sent.
 *
 * Karen currently enables one registry (see `ENABLED_SOURCES`), so the picker
 * renders as a statement rather than a choice. The multi-registry path is kept
 * intact -- merged results stay labelled per row, and each registry reports
 * its own outcome -- because the labelling is what makes more than one safe,
 * and it should not have to be rebuilt if a second is ever enabled.
 */

import { useCallback, useMemo, useState } from "react";

import {
  age, compact, describeDownloads, KINDS, kindById, loadable, LOADABLE_WORDS,
  ggufIsMeaningful, PUBLISHERS, publisherNote, recipeFor, SORTS,
  type BrowseSort, type HfModel, type Publisher,
} from "../../core/runtime/hfBrowse.ts";
import {
  REGISTRY_HOST,
  REGISTRY_LABEL,
  ENABLED_SOURCES,
  REGISTRY_NAME,
  type RegistrySource,
} from "../../core/runtime/registry.ts";
import type { CardTarget } from "./ModelCard.tsx";

export function RegistrySearch({
  installedEngines,
  onOpen,
}: {
  /** Engines with a backend installed, so a row can say what it still needs. */
  installedEngines?: ReadonlySet<string>;
  /**
   * Open one result.
   *
   * A row used to expand into a strip of filenames in place. It now opens a
   * page, because the strip could answer "which file" and nothing else -- not
   * the licence, not the context length, not what the publisher says the model
   * is for -- and those are the questions somebody is actually on this screen
   * to answer.
   */
  onOpen: (target: CardTarget) => void;
}) {
  const [query, setQuery] = useState("");
  /* Seeded from the enabled set, never from a stored preference: which
     registries Karen will contact is a property of the build, not something a
     window can widen. */
  const [sources, setSources] = useState<Set<RegistrySource>>(new Set(ENABLED_SOURCES));
  /* Browsing state. `author` is a publisher asked for exactly; `kind` is a
     pipeline tag; both go to the registry rather than being applied here, so
     what the tab says and what the page holds cannot drift apart. */
  const [kind, setKind] = useState("all");
  /* A set, not one value: makers and GGUF builders publish different things
     and the useful browse is often both at once -- "Meta and Unsloth" is how
     you see a Llama release and the builds of it side by side. */
  const [authors, setAuthors] = useState<string[]>([]);
  const [sort, setSort] = useState<BrowseSort>("downloads");
  const [ggufOnly, setGgufOnly] = useState(true);
  const [models, setModels] = useState<HfModel[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | undefined>();
  const [ranBrowse, setRanBrowse] = useState<string | undefined>();
  /** Whether the publisher chips are showing. Two rows of them, so: folded. */
  const [showPublishers, setShowPublishers] = useState(false);

  const chosen = useMemo(() => ENABLED_SOURCES.filter((s) => sources.has(s)), [sources]);

  /** Add or remove one publisher, keeping the rest, and re-run the browse. */
  const toggleAuthor = (who: string): void => {
    const next = authors.includes(who) ? authors.filter((a) => a !== who) : [...authors, who];
    setAuthors(next);
    setQuery("");
    void browse({ authors: next, query: "" });
  };
  const busy = browsing;

  /* Unused while one registry is enabled, and kept for when that changes:
     re-enabling is meant to be a one-line edit to ENABLED_SOURCES, not a
     rebuild of this component. */
  const toggle = (source: RegistrySource): void => {
    setSources((prev) => {
      const next = new Set(prev);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  };

  /**
   * Ask the registry for a page.
   *
   * One call, with whatever the controls currently say. The filters are
   * parameters on the request rather than a pass over the results, so the tab
   * count and the rows cannot disagree -- which is what happened when a
   * "chat" tab filtered a page that had already been truncated at fifty.
   */
  const browse = useCallback(
    async (patch: {
      kind?: string;
      authors?: string[];
      sort?: BrowseSort;
      ggufOnly?: boolean;
      query?: string;
    } = {}): Promise<void> => {
      const next = {
        kind: patch.kind ?? kind,
        authors: patch.authors ?? authors,
        sort: patch.sort ?? sort,
        ggufOnly: patch.ggufOnly ?? ggufOnly,
        query: patch.query ?? query,
      };
      setBrowsing(true);
      setBrowseError(undefined);

      const res = await window.karen.hfBrowse({
        ...(next.query.trim() ? { query: next.query.trim() } : {}),
        ...(next.authors.length ? { authors: next.authors } : {}),
        kind: next.kind,
        sort: next.sort,
        ggufOnly: next.ggufOnly,
      });

      setBrowsing(false);
      if (!res.ok || !res.result) {
        setBrowseError(res.error ?? "The registry could not be reached.");
        setModels([]);
        return;
      }
      setModels(res.result.models);
      /* Describes the whole selection, not just the last thing pressed.
         Choosing a publisher and then a kind left the line reading "Everything
         published by ibm-granite" over an empty image-model list. */
      const parts = [
        next.kind === "all" ? "Models" : `${kindById(next.kind).title} models`,
        next.authors.length ? `from ${next.authors.join(", ")}` : undefined,
        next.query.trim() ? `matching “${next.query.trim()}”` : undefined,
      ].filter(Boolean);
      setRanBrowse(parts.join(" "));
    },
    [kind, authors, sort, ggufOnly, query],
  );

  return (
    <section className="lem-section reg">
      <header className="lem-head">
        <h3>Search {REGISTRY_LABEL[ENABLED_SOURCES[0] ?? "huggingface"]}</h3>
        <p>
          Karen searches one registry, and names it and its country on every result — a download’s
          origin is a matter of institutional policy for many researchers, not a detail.
        </p>
      </header>

      {/* ---------------- the controls ---------------- */}
      <div className="reg-bar">
        {/* With a single registry this is a statement, not a choice: a lone
            tick box that cannot be unticked is a control that does nothing.
            It keeps the shape of the badge used on every row below, so the
            two read as the same fact. */}
        <div className="reg-sources" role="group" aria-label="Registry being searched">
          {ENABLED_SOURCES.length === 1
            ? ENABLED_SOURCES.map((source) => (
                <span key={source} className={`reg-source on fixed ${source}`} title={REGISTRY_HOST[source]}>
                  <span className="reg-source-name">{REGISTRY_LABEL[source]}</span>
                  <span className="reg-source-host">{REGISTRY_HOST[source]}</span>
                </span>
              ))
            : ENABLED_SOURCES.map((source) => (
                <label
                  key={source}
                  className={sources.has(source) ? `reg-source on ${source}` : `reg-source ${source}`}
                  title={REGISTRY_HOST[source]}
                >
                  <input type="checkbox" checked={sources.has(source)} onChange={() => toggle(source)} />
                  <span className="reg-source-name">{REGISTRY_LABEL[source]}</span>
                  <span className="reg-source-host">{REGISTRY_HOST[source].split(" — ")[1]}</span>
                </label>
              ))}
        </div>

        <div className="reg-query">
          <input
            type="search"
            className="reg-input"
            placeholder="Model name, family, or organisation — “qwen”, “whisper”, “unsloth”"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              /* The box is one more filter on the same request, not a
                 separate mechanism -- so a search inside a publisher stays
                 inside that publisher, which is what a person expects after
                 clicking one. */
              if (e.key === "Enter") void browse({ query });
            }}
            aria-label="Search the model registries"
          />
          <button
            type="button"
            className="reg-go"
            disabled={browsing || !chosen.length}
            onClick={() => void browse({ query })}
          >
            Search
          </button>
        </div>

        {/* Said before the search runs, in the words of what actually happens.
            Nothing has been sent at this point -- that is the difference this
            sentence is describing. */}
        <p className="reg-egress">
          {chosen.length === 0 ? (
            <>No registry is enabled, so there is nothing to search.</>
          ) : (
            <>
              {/* Quoting an empty box back as “…” claimed Karen would send
                  an ellipsis, which is both untrue and the sort of small
                  inaccuracy that makes the rest of the sentence -- the part
                  about what leaves this machine -- less believable. */}
              {query.trim() ? <>Pressing Search sends “{query.trim()}” to{" "}</> : <>Nothing is sent until you press Search. Then what you typed goes to{" "}</>}
              {chosen.map((s, i) => (
                <span key={s}>
                  {i > 0 ? " and " : ""}
                  <strong className={`reg-inline ${s}`}>{REGISTRY_LABEL[s]}</strong>
                </span>
              ))}
              {query.trim() ? <>. Typing sends nothing.</> : <>, and nothing else does.</>}
            </>
          )}
        </p>
      </div>

      {/* ---------------- browse ---------------- */}
      {/*
        * The registry's own filters, as controls.
        *
        * Every one of these is a parameter on the request rather than a pass
        * over the results, which is the whole point: the old search could only
        * say `search=<text>` capped at fifty, so "everything IBM publishes"
        * could not be expressed and a publisher with 36 repositories showed
        * five. Kind, publisher and sort are questions the registry answers.
        */}
      <div className="reg-browse">
        <div className="reg-kinds" role="tablist" aria-label="Kind of model">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              role="tab"
              aria-selected={k.id === kind}
              className={k.id === kind ? "lem-tab on" : "lem-tab"}
              disabled={browsing}
              onClick={() => {
                /* The text box is cleared, because a tab press means "show me
                   these" and a stale query silently narrows it to nothing.
                   Searching "granite" and then pressing Transcription gave
                   eighteen rows of Granite speech models and looked broken;
                   pressing it now gives every transcription model there is,
                   which is what the tab says it does. */
                setKind(k.id);
                setQuery("");
                void browse({ kind: k.id, query: "" });
              }}
            >
              {k.title}
            </button>
          ))}
        </div>

        <div className="reg-controls">
          <label className="reg-control">
            <span>Sort</span>
            <select
              value={sort}
              disabled={browsing}
              onChange={(e) => {
                const next = e.target.value as BrowseSort;
                setSort(next);
                void browse({ sort: next });
              }}
            >
              {SORTS.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </label>

          {/* A visible switch rather than a silent rule. Off, this shows what
              the registry holds -- original weights included -- which is what
              a publisher's own page shows. */}
          {/* Only offered where it means something: `filter=gguf` is a
              llama.cpp filter, and on the image, speech and voice tabs it
              would hide the safetensors and ggml files those engines read. */}
          {ggufIsMeaningful(kindById(kind)) ? (
            <label className="lem-toggle">
              <input
                type="checkbox"
                checked={ggufOnly}
                disabled={browsing}
                onChange={(e) => {
                  setGgufOnly(e.target.checked);
                  void browse({ ggufOnly: e.target.checked });
                }}
              />
              Only GGUF builds
            </label>
          ) : null}

          {authors.length ? (
            <button
              type="button"
              className="reg-chip on"
              disabled={browsing}
              onClick={() => {
                setAuthors([]);
                void browse({ authors: [] });
              }}
            >
              Clear {authors.length} publisher{authors.length === 1 ? "" : "s"} ✕
            </button>
          ) : null}
        </div>

        {/* Folded away, because two rows of chips sat above every result and
            were read once. The chosen ones stay visible above whatever else is
            on screen -- an active filter that is hidden is an active filter
            somebody will blame the registry for. */}
        <button
          type="button"
          className="reg-more"
          aria-expanded={showPublishers}
          onClick={() => setShowPublishers((on) => !on)}
        >
          {showPublishers ? "Hide publishers" : "Filter by publisher"}
        </button>

        {showPublishers ? (
          <>
            <div className="reg-chips">
              <span className="reg-chips-key">Model makers</span>
              {PUBLISHERS.filter((p) => !p.builder).map((p) => (
                <PublisherChip key={p.author} p={p} on={authors.includes(p.author)} busy={browsing} onPick={toggleAuthor} />
              ))}
            </div>

            {/* Kept apart, because they publish different things and mixing
                them is how a browse ends up empty: Meta publishes no GGUF at
                all, and the Llama builds people actually run come from these
                four. */}
            <div className="reg-chips">
              <span className="reg-chips-key">GGUF builders</span>
              {PUBLISHERS.filter((p) => p.builder).map((p) => (
                <PublisherChip key={p.author} p={p} on={authors.includes(p.author)} busy={browsing} onPick={toggleAuthor} />
              ))}
            </div>
          </>
        ) : null}
      </div>

      {browseError ? <p className="reg-line bad">{browseError}</p> : null}
      {browsing ? (
        <p className="reg-line">
          <span className="lem-spinner" aria-hidden="true" />
          Asking {REGISTRY_LABEL[chosen[0] ?? "huggingface"]}…
        </p>
      ) : ranBrowse ? (
        <p className="reg-line">
          <span className={`reg-tag ${chosen[0] ?? "huggingface"}`}>
            {REGISTRY_LABEL[chosen[0] ?? "huggingface"]}
          </span>
          {ranBrowse} — {models.length} shown
          {models.length === 100 ? " (the first page)" : ""}
          {/* What was actually asked, rather than a fixed sentence: the kind's
              own description said "unfiltered" while the GGUF switch was on,
              which is the kind of small contradiction that makes a person stop
              believing the rest of the line. */}
          {ggufOnly && ggufIsMeaningful(kindById(kind)) ? ", GGUF builds only" : ""}
          {/* Stated, so the order can be checked rather than taken on trust.
              A list whose ordering is invisible is one people assume is
              broken the moment two rows look out of sequence -- and with four
              sorts and a figure column that only matches one of them, that
              happens often. */}
          , sorted by {(SORTS.find((o) => o.id === sort)?.label ?? "").toLowerCase()}.
          {kind === "all" ? null : <> {kindById(kind).hint}</>}
        </p>
      ) : null}


      {/* ---------------- results ---------------- */}
      {!browsing && ranBrowse && !models.length && !browseError ? (
        <div className="lem-callout">
          <p className="lem-callout-title">Nothing here.</p>
          <p className="lem-callout-body">
            {(authors.length === 1 ? publisherNote(authors[0]) : undefined) ??
              (authors.length && kind !== "all"
                ? `${authors.join(", ")} publish${authors.length === 1 ? "es" : ""} no ${kindById(kind).title.toLowerCase()} models. Clear the publishers, or choose another kind.`
                : ggufOnly
                  ? "Nothing in this selection is published as GGUF. Turn off “Only models Karen can run” to see what else is there."
                  : "The registry returned no repositories for this selection.")}
          </p>
        </div>
      ) : null}

      {models.length ? (
        <>
        {/* Headings, because the figures are otherwise two glyphs a person has
            to guess at, and one of them is the closest thing a registry gives
            to a quality signal. */}
        <div className="reg-cols" aria-hidden="true">
          <span>Repository</span>
          <span>Registry</span>
          <span>Runs here</span>
          <span className="num">Pulls · 30d</span>
          <span className="num">Likes</span>
          <span />
        </div>
        <ul className="reg-hits">
          {models.map((model) => {
            const source: RegistrySource = chosen[0] ?? "huggingface";
            const key = `${source}/${model.id}`;
            /* Decided once per row and used for three things: which list of
               files to fetch, which engine the download registers under, and
               whether that engine is present. They must agree, or a repository
               is described by one engine and installed for another. */
            const recipe = recipeFor(model, kindById(kind));
            const can = loadable(model, recipe, installedEngines);
            const words = LOADABLE_WORDS[can];
            const created = age(model.createdAt);
            return (
              <li key={key} className="reg-hit">
                <button
                  type="button"
                  className="reg-hit-head"
                  onClick={() => onOpen({ repo: model.id, recipe, source })}
                >
                  <span className="reg-hit-id">
                    <span className="reg-hit-name">{model.id}</span>
                    <span className="reg-hit-alt">
                      {/* What differs between rows: what it is for, how old it
                          is, and whether the licence has to be accepted first.
                          Not repeated boilerplate. */}
                      {[
                        model.task,
                        created ? `added ${created}` : undefined,
                        model.gated ? "licence must be accepted" : undefined,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  {/*
                    * The registry, in a column of its own.
                    *
                    * It has to be on every row -- an unlabelled row is
                    * ambiguous to someone checking an institutional policy,
                    * which is the whole reason this is shown. But as a bright
                    * pill at the start of every row it was the loudest thing
                    * on the page while being the same on all of them. In a
                    * column, identical values read instantly as "all from one
                    * place", which is the actual question.
                    */}
                  <span className={`reg-hit-src ${source}`} title={REGISTRY_NAME[source]}>
                    {REGISTRY_LABEL[source]}
                  </span>
                  {/* Whether Karen can load it, rather than whether it is
                      GGUF -- a GGUF diffusion model is not runnable here, and
                      the format alone does not say so. */}
                  <span className={`lem-chip ${words.tone}`} title={words.why}>
                    {words.short}
                  </span>
                  <span
                    className="reg-hit-figure"
                    title={`${describeDownloads(model.downloads)} — the registry counts every pull, automated ones included`}
                  >
                    {compact(model.downloads)}
                  </span>
                  <span className="reg-hit-figure" title="People who have starred this repository">
                    {compact(model.likes)}
                  </span>
                  <span className="reg-hit-open" aria-hidden="true">Open ›</span>
                </button>
              </li>
            );
          })}
        </ul>
        </>
      ) : null}

    </section>
  );
}

/**
 * One publisher, as a toggle.
 *
 * A toggle rather than a radio because the useful browse is often two at once:
 * Meta publishes the Llama weights and Unsloth publishes the GGUF builds of
 * them, and seeing those together is the thing neither list gives on its own.
 */
function PublisherChip({
  p,
  on,
  busy,
  onPick,
}: {
  p: Publisher;
  on: boolean;
  busy: boolean;
  onPick: (author: string) => void;
}) {
  return (
    <button
      type="button"
      className={on ? "reg-chip small on" : "reg-chip small"}
      disabled={busy}
      aria-pressed={on}
      title={`Everything published by ${p.author}`}
      onClick={() => onPick(p.author)}
    >
      {p.label}
    </button>
  );
}
