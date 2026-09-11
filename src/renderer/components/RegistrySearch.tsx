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
 * MyRA currently enables one registry (see `ENABLED_SOURCES`), so the picker
 * renders as a statement rather than a choice. The multi-registry path is kept
 * intact -- merged results stay labelled per row, and each registry reports
 * its own outcome -- because the labelling is what makes more than one safe,
 * and it should not have to be rebuilt if a second is ever enabled.
 */

import { useCallback, useMemo, useState } from "react";

import type { CatalogEntry } from "../../core/runtime/catalog.ts";
import { groupCatalog } from "../../core/runtime/catalog.ts";
import type { Machine } from "../../core/runtime/fit.ts";
import { parameterLabel, publisherOf, readableName } from "../../core/runtime/modelNames.ts";
import { partitionByRunnable, type Runnable } from "../../core/runtime/runnable.ts";
import type { PullProgress } from "../../core/runtime/systemInfo.ts";
import { repoOf } from "../../core/runtime/catalog.ts";
import { ModelCard } from "./ModelCard.tsx";

import {
  age, applyLocalFilter, compact, describeDownloads, describeFiltered, KINDS, kindById,
  loadable, LOADABLE_WORDS, MIN_DOWNLOADS, ggufIsMeaningful, PUBLISHERS, publisherNote,
  recipeFor, SORTS, splitPublishers, UPLOADED_WITHIN,
  type BrowseSort, type HfModel, type LocalFilter, type Publisher,
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
  machine,
  have,
  catalog,
  states,
  pulling,
  job,
  onDownload,
}: {
  /** Engines with a backend installed, so a row can say what it still needs. */
  installedEngines?: ReadonlySet<string>;
  machine: Machine;
  /** Model ids already on this machine, so the card can say so. */
  have: Set<string>;
  /** MyRA's own list, for the screen before anything has been searched. */
  catalog: CatalogEntry[];
  /** What each engine can do here, so the picks are ones that would run. */
  states: Map<string, Runnable>;
  /** The download in flight, and its figures, both owned by the pane above. */
  pulling: string | undefined;
  job: PullProgress | undefined;
  onDownload: (source: RegistrySource, choice: { name: string; checkpoint: string; recipe: string }) => void;
}) {
  /*
   * The selected model lives here, not in the pane above.
   *
   * That is the whole point of the split: the results stay on screen while a
   * model is read, so choosing one must not unmount the list that produced it.
   * On a narrow window CSS hides the list instead and the card's own back link
   * appears -- the component tree is the same at both widths, so there is no
   * breakpoint in the JavaScript to disagree with the one in the stylesheet.
   */
  const [selected, setSelected] = useState<CardTarget | undefined>();
  const [query, setQuery] = useState("");
  /* Seeded from the enabled set, never from a stored preference: which
     registries MyRA will contact is a property of the build, not something a
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
  /* Applied to what came back rather than asked of the registry, which has no
     filter for either. `describeFiltered` is what keeps that honest on screen. */
  const [within, setWithin] = useState("any");
  const [minPulls, setMinPulls] = useState("any");
  /** Whether the last browse crossed publishers, and what it could not ask. */
  const [crossed, setCrossed] = useState(false);
  const [dropped, setDropped] = useState(0);
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | undefined>();
  const [ranBrowse, setRanBrowse] = useState<string | undefined>();
  /** Whether the publisher chips are showing. Two rows of them, so: folded. */
  const [showPublishers, setShowPublishers] = useState(false);
  /** Whether the sort and filters are showing. One line when they are not. */
  const [refining, setRefining] = useState(false);

  const chosen = useMemo(() => ENABLED_SOURCES.filter((s) => sources.has(s)), [sources]);

  /**
   * Add or remove one publisher, keeping the rest, and re-run the browse.
   *
   * The text box is no longer cleared. It used to be, on the reasoning that a
   * stale query silently narrows a publisher's page to nothing -- but the query
   * is now part of the same question rather than a competing one, so
   * "Granite + Unsloth" with `3.3` typed in narrows to Unsloth's Granite 3.3
   * builds instead of throwing the words away.
   */
  const toggleAuthor = (who: string): void => {
    const next = authors.includes(who) ? authors.filter((a) => a !== who) : [...authors, who];
    setAuthors(next);
    void browse({ authors: next });
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

      const res = await window.myra.hfBrowse({
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
      setCrossed(res.result.crossed);
      setDropped(res.result.dropped);
      /* Describes the whole selection, not just the last thing pressed.
         Choosing a publisher and then a kind left the line reading "Everything
         published by ibm-granite" over an empty image-model list. */
      /* Says what was actually asked, including whether the publishers were
         crossed. "from ibm-granite, unsloth" describes a union, and a union is
         not what a crossing returns. */
      const { makers, builders } = splitPublishers(next.authors);
      const who = makers.length && builders.length
        ? `${builders.map((b) => b.label).join(" and ")} builds of ${makers.map((mk) => mk.label).join(" or ")}`
        : next.authors.length
          ? `from ${[...makers, ...builders].map((p) => p.label).join(", ")}`
          : undefined;
      const parts = [
        next.kind === "all" ? "Models" : `${kindById(next.kind).title} models`,
        who,
        next.query.trim() ? `matching “${next.query.trim()}”` : undefined,
      ].filter(Boolean);
      setRanBrowse(parts.join(" "));
    },
    [kind, authors, sort, ggufOnly, query],
  );

  /* Applied here, once, so the rows and every count drawn from them agree. */
  const filter = useMemo<LocalFilter>(() => {
    const days = UPLOADED_WITHIN.find((o) => o.id === within)?.days;
    const least = MIN_DOWNLOADS.find((o) => o.id === minPulls)?.n;
    return {
      ...(days !== undefined ? { withinDays: days } : {}),
      ...(least !== undefined ? { minDownloads: least } : {}),
    };
  }, [within, minPulls]);
  /* What the closed refine row shows. Only what differs from the defaults --
     a summary that always says "Sorted by most downloaded" is a summary nobody
     reads, and then a real filter hides in it. */
  const refineSummary = useMemo(() => {
    const out: string[] = [];
    if (sort !== "downloads") out.push(SORTS.find((o) => o.id === sort)?.label ?? sort);
    if (!ggufOnly && ggufIsMeaningful(kindById(kind))) out.push("Every format");
    const uploaded = UPLOADED_WITHIN.find((o) => o.id === within);
    if (uploaded?.days) out.push(`Uploaded ${uploaded.label.toLowerCase()}`);
    const pulls = MIN_DOWNLOADS.find((o) => o.id === minPulls);
    if (pulls?.n) out.push(`${pulls.label} downloads`);
    if (authors.length) {
      const { makers, builders } = splitPublishers(authors);
      out.push([...makers, ...builders].map((pub) => pub.label).join(" + "));
    }
    return out;
  }, [sort, ggufOnly, kind, within, minPulls, authors]);

  const filtered = useMemo(() => applyLocalFilter(models, filter), [models, filter]);
  const localNote = describeFiltered(filtered, models.length, filter, sort);
  const rows = filtered.shown;

  return (
    <section className="lem-section reg" data-selected={selected ? "true" : "false"}>
      {/* ---------------- the controls ---------------- */}
      <div className="reg-bar">
        {/* With a single registry this is a statement, not a choice: a lone
            tick box that cannot be unticked is a control that does nothing.
            It keeps the shape of the badge used on every result below, so the
            two read as the same fact.

            On the header line rather than a row of its own: it was one of seven
            rows of chrome that pushed the first result six lines below the
            fold, and it says the same thing there in a quarter of the height. */}
        <div className="reg-query">
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
              {/* Quoting an empty box back as “…” claimed MyRA would send
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

        {/*
          * Folded, with whatever is set showing on the closed row.
          *
          * Four controls sat here whether or not any of them was in use, and
          * with the tabs above and the publishers below they were most of the
          * reason the first result began six lines below the fold. Closed, this
          * is one line; open, it is exactly what it was.
          */}
        <div className="reg-refine">
          <button
            type="button"
            className="reg-more"
            aria-expanded={refining}
            onClick={() => setRefining((on) => !on)}
          >
            {refining ? "Fewer options" : "Sort and filter"}
          </button>
          {refining ? null : (
            <div className="reg-refine-set">
              {refineSummary.map((what) => (
                <span key={what} className="reg-set">{what}</span>
              ))}
            </div>
          )}
        </div>

        <div className={refining ? "reg-controls" : "reg-controls folded"}>
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

          {/* Two filters the registry cannot express, so they narrow the page
              that came back. Kept beside the sort rather than with the tabs,
              because the sort is what decides which hundred rows they get to
              narrow -- and `localNote` says so out loud. */}
          <label className="reg-control">
            <span>Uploaded</span>
            <select
              value={within}
              disabled={browsing}
              onChange={(e) => setWithin(e.target.value)}
            >
              {UPLOADED_WITHIN.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </label>

          <label className="reg-control">
            <span>Downloads</span>
            <select
              value={minPulls}
              disabled={browsing}
              onChange={(e) => setMinPulls(e.target.value)}
            >
              {MIN_DOWNLOADS.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </label>

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
            were read once. What is chosen shows on the closed refine row above,
            so an active filter is never hidden -- an active filter somebody
            cannot see is one they blame the registry for. */}
        {refining ? (
          <button
            type="button"
            className="reg-more"
            aria-expanded={showPublishers}
            onClick={() => setShowPublishers((on) => !on)}
          >
            {showPublishers ? "Hide publishers" : "Filter by publisher"}
          </button>
        ) : null}

        {refining && showPublishers ? (
          <>
            {/* Said where the choice is made, because it is not the behaviour
                a list of tick boxes implies. */}
            <p className="reg-chips-note">
              Two makers, or two builders, widen the search. A maker <em>and</em> a builder narrow
              it: IBM and Unsloth means Unsloth’s builds of Granite, not both publishers’ output.
            </p>
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
          {ranBrowse} — {rows.length} shown
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
          {/* Crossing is not what a list of tick boxes implies, so the line
              that describes the search says which of the two it did. */}
          {crossed ? <> Publishers were crossed, not combined.</> : null}
          {dropped ? (
            <> {dropped} publisher {dropped === 1 ? "pairing was" : "pairings were"} not
              asked for — that many requests to one registry is more than MyRA will make at
              once. Choose fewer publishers.</>
          ) : null}
        </p>
      ) : null}

      {/* Its own line, and in the app's own voice rather than appended to the
          sentence above: this one is about what MyRA did to the answer after
          it arrived, which is a different kind of fact from what it asked. */}
      {localNote && !browsing ? <p className="reg-line local">{localNote}</p> : null}

      {/* Above the columns, where it has the width to be one line. Inside the
          results column it wrapped to three and pushed the first suggestion
          further down than the thing it was apologising for. */}
      {!ranBrowse && !browsing ? (
        <p className="reg-line">
          A few MyRA suggests, from the list that ships with it — nothing was fetched to show
          these, and nothing is sent until you search.
        </p>
      ) : null}


      {/* ---------------- results, beside the model ---------------- */}
      {/*
        * The list stays put while a model is read.
        *
        * Both columns are always rendered and the narrow case is handled in the
        * stylesheet -- below 1080px the results column is hidden while
        * something is selected and the card's own back link appears. Doing it
        * that way means there is no breakpoint in the JavaScript that can
        * disagree with the one in the CSS, which is the usual way a responsive
        * layout ends up with two of something or none.
        */}
      <div className="reg-split">
        <div className="reg-results">
          {/* Filtered to nothing is a different problem from returned nothing,
              and telling somebody the registry holds no Granite models when it
              was MyRA's own date filter that emptied the list would be a lie. */}
          {!browsing && ranBrowse && models.length > 0 && !rows.length ? (
            <div className="lem-callout">
              <p className="lem-callout-title">Nothing on this page matches those filters.</p>
              <p className="lem-callout-body">
                The registry returned {models.length}. {localNote}
              </p>
            </div>
          ) : null}

          {!browsing && ranBrowse && !models.length && !browseError ? (
            <div className="lem-callout">
              <p className="lem-callout-title">Nothing here.</p>
              <p className="lem-callout-body">
                {(authors.length === 1 ? publisherNote(authors[0]) : undefined) ??
                  (authors.length && kind !== "all"
                    ? `${authors.join(", ")} publish${authors.length === 1 ? "es" : ""} no ${kindById(kind).title.toLowerCase()} models. Clear the publishers, or choose another kind.`
                    : ggufOnly
                      ? "Nothing in this selection is published as GGUF. Turn off “Only GGUF builds” to see what else is there."
                      : "The registry returned no repositories for this selection.")}
              </p>
            </div>
          ) : null}

          {/*
            * Before anything has been searched: MyRA's own list.
            *
            * An empty box under a screenful of controls is a page that tells a
            * person who does not already know a model's name that they have
            * come to the wrong place. This is the catalogue shipped inside the
            * Lemonade install, filtered to what this machine could actually
            * run -- so it costs no request, which is why it can be shown
            * without anybody having pressed anything.
            */}
          {!ranBrowse && !browsing ? <Picks
            catalog={catalog}
            states={states}
            have={have}
            onOpen={setSelected}
            selected={selected?.repo}
          /> : null}

          {rows.map((model) => {
            const source: RegistrySource = chosen[0] ?? "huggingface";
            /* Decided once per row and used for three things: which list of
               files to fetch, which engine the download registers under, and
               whether that engine is present. They must agree, or a repository
               is described by one engine and installed for another. */
            const recipe = recipeFor(model, kindById(kind));
            return (
              <ResultRow
                key={`${source}/${model.id}`}
                model={model}
                source={source}
                recipe={recipe}
                installedEngines={installedEngines}
                on={selected?.repo === model.id}
                onOpen={setSelected}
              />
            );
          })}
        </div>

        <div className="reg-detail">
          {selected ? (
            <ModelCard
              target={selected}
              machine={machine}
              have={have}
              pulling={pulling}
              job={job}
              onDownload={(choice) => onDownload(selected.source, choice)}
              onBack={() => setSelected(undefined)}
            />
          ) : (
            <p className="reg-detail-hint">
              {rows.length
                ? "Choose a model to see its licence, its versions and what its author says about it."
                : "Search for a model, or choose one of MyRA’s from the list."}
            </p>
          )}
        </div>
      </div>

    </section>
  );
}

/**
 * One result, as a name rather than as a row of a table.
 *
 * The old row was six columns of 11px mono: a repository id, a registry, the
 * word "Ready", "12.7M", "956", "Open ›". Every one of those is a fact, and
 * together they answered none of the three questions somebody actually has --
 * what is this, how big is it, and can I run it.
 *
 * So the name comes first, at a size a person reads rather than parses, and
 * everything else becomes one quiet line under it. The raw id stays as the
 * tooltip and on the card, because it is what somebody checking an
 * institutional policy needs to see exactly.
 */
function ResultRow({
  model,
  source,
  recipe,
  installedEngines,
  on,
  onOpen,
}: {
  model: HfModel;
  source: RegistrySource;
  recipe: string;
  installedEngines?: ReadonlySet<string> | undefined;
  on: boolean;
  onOpen: (target: CardTarget) => void;
}) {
  const can = loadable(model, recipe, installedEngines);
  const words = LOADABLE_WORDS[can];
  const size = parameterLabel(model.id);
  const created = age(model.createdAt);

  return (
    <button
      type="button"
      className={on ? "reg-hit on" : "reg-hit"}
      title={model.id}
      aria-current={on}
      onClick={() => onOpen({ repo: model.id, recipe, source })}
    >
      <span className="reg-hit-top">
        <span className="reg-hit-name">{readableName(model.id)}</span>
        {/* Only where it says something. "Ready" on every row is noise, and a
            row that cannot run is the one fact worth interrupting for. */}
        {can === "ready" ? null : (
          <span className={`lem-chip ${words.tone}`} title={words.why}>{words.short}</span>
        )}
      </span>
      <span className="reg-hit-sub">
        {/* Who built it, set apart from what it is: `unsloth` is not part of
            the model's name and reading it as one is how a list of forty
            repositories becomes unscannable. */}
        <span className="reg-hit-by">{publisherOf(model.id) ?? ""}</span>
        {/* What the repository's own name claims. Never an estimate of the
            download -- see `modelNames.ts` for why the exact figure waits for
            the card, where the registry has reported real bytes. */}
        {size ? <span className="reg-hit-size">{size}</span> : null}
        {/* On every row, and with its country. An unlabelled row is ambiguous
            to somebody checking where a download may come from, which is the
            whole reason it is shown. */}
        <span className={`reg-hit-src ${source}`} title={REGISTRY_NAME[source]}>
          {REGISTRY_LABEL[source]}
        </span>
        {model.downloads !== undefined ? (
          <span title={describeDownloads(model.downloads)}>
            {/* Spelled out. "12.7M" under a column headed "PULLS · 30D" is two
                pieces of jargon saved eleven characters. */}
            {compact(model.downloads)} downloads this month
          </span>
        ) : null}
        {created ? <span>added {created}</span> : null}
        {model.gated ? <span className="reg-hit-gated">licence to accept</span> : null}
      </span>
    </button>
  );
}

/**
 * MyRA's own list, for the screen before anything has been searched.
 *
 * Grouped by what a model is FOR rather than by which engine runs it, which is
 * `LABEL_GROUPS`' whole reason for existing, and filtered to what this machine
 * could actually run -- offering somebody a model their hardware cannot load is
 * worse than offering nothing.
 *
 * A few per group, not all 228. This is a starting point, not the catalogue;
 * the Recommended tab is the catalogue.
 */
function Picks({
  catalog,
  states,
  have,
  selected,
  onOpen,
}: {
  catalog: CatalogEntry[];
  states: Map<string, Runnable>;
  have: Set<string>;
  selected: string | undefined;
  onOpen: (target: CardTarget) => void;
}) {
  const groups = useMemo(
    () =>
      groupCatalog(catalog)
        .map((group) => ({
          ...group,
          /* Upstream's own shortlist first -- `sortForDisplay` has already put
             it there -- and only the ones with a repository behind them, since
             a pick that cannot open a card is a dead row. */
          entries: partitionByRunnable(group.entries, states)
            .usable.filter((entry) => repoOf(entry.checkpoint))
            .slice(0, 4),
        }))
        .filter((group) => group.entries.length),
    [catalog, states],
  );

  if (!groups.length) return null;

  return (
    <div className="reg-picks">
      {groups.map((group) => (
        <div key={group.id} className="reg-picks-group">
          <h4 className="reg-picks-title">{group.title}</h4>
          {group.entries.map((entry) => {
            const repo = repoOf(entry.checkpoint) ?? "";
            const size = parameterLabel(entry.id) ?? (entry.sizeBytes ? gbLabel(entry.sizeBytes) : undefined);
            return (
              <button
                key={entry.id}
                type="button"
                className={selected === repo ? "reg-hit on" : "reg-hit"}
                title={entry.checkpoint ?? entry.id}
                onClick={() => onOpen({ repo, recipe: entry.recipe, source: entry.source })}
              >
                <span className="reg-hit-top">
                  <span className="reg-hit-name">{readableName(entry.id)}</span>
                  {have.has(entry.id) ? <span className="lem-chip dim">Downloaded</span> : null}
                </span>
                <span className="reg-hit-sub">
                  <span className="reg-hit-by">{publisherOf(repo) ?? ""}</span>
                  {size ? <span className="reg-hit-size">{size}</span> : null}
                  <span className={`reg-hit-src ${entry.source}`}>{REGISTRY_LABEL[entry.source]}</span>
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** The catalogue rounds to whole gigabytes, so this is a fallback, not a figure. */
function gbLabel(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(bytes < 1024 ** 3 ? 1 : 0)} GB`;
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
