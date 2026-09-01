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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fitModel, quantRank, type Machine, type Verdict } from "../../core/runtime/fit.ts";
import type { PullProgress } from "../../core/runtime/systemInfo.ts";
import {
  age, compact, describeDownloads, KINDS, kindById, loadable, loadableFiles, LOADABLE_WORDS,
  ggufIsMeaningful, PUBLISHERS, publisherNote, pullCheckpoint, pullName, recipeFor, SORTS,
  type BrowseSort, type HfModel, type Publisher, type RepoFile,
} from "../../core/runtime/hfBrowse.ts";
import {
  checkpointFor,
  explainRegistryError,
  modelNameFor,
  recommendVariant,
  REGISTRY_HOST,
  REGISTRY_LABEL,
  ENABLED_SOURCES,
  REGISTRY_NAME,
  type RegistrySource,
  type RepoVariants,
} from "../../core/runtime/registry.ts";

const FIT_CHIP: Record<Verdict, { short: string; tone: string }> = {
  gpu: { short: "Fits on GPU", tone: "good" },
  partial: { short: "Part on GPU", tone: "warn" },
  cpu: { short: "Processor", tone: "dim" },
  "too-large": { short: "Too large", tone: "bad" },
};

/**
 * A size in the unit that shows movement.
 *
 * `gb` renders everything in gigabytes, which is right in a column of model
 * sizes and useless on a progress line: a 310 MB download spends its whole
 * life reading "0.00 GB of 0.31 GB". Below a gigabyte this switches to
 * megabytes, and below a megabyte to kilobytes, so the number always changes
 * while bytes are actually arriving.
 */
function size(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} kB`;
}

/** `sd_turbo.safetensors` from `unet/sd_turbo.safetensors`, for a model name. */
function leafOf(path: string): string {
  const leaf = path.split("/").pop() ?? path;
  return leaf.replace(/\.[A-Za-z0-9]+$/, "");
}

function gb(bytes?: number): string {
  return bytes ? `${(bytes / 1024 ** 3).toFixed(bytes < 1024 ** 3 ? 2 : 1)} GB` : "—";
}

/**
 * All that a download needs to identify a repository.
 *
 * Narrower than the full result on purpose: a row now comes from the
 * registry's own API and a variant list only ever needed these two fields, so
 * requiring the whole shape would mean inventing values to satisfy a type.
 */
interface RepoRef {
  id: string;
  source: RegistrySource;
}

interface VariantState {
  loading: boolean;
  error?: string;
  /** Lemonade's grouped quantisations, for GGUF repositories. */
  data?: RepoVariants;
  /** The registry's own file list, for everything else. */
  files?: RepoFile[];
}

export function RegistrySearch({
  machine,
  have,
  installedEngines,
  onDownloaded,
}: {
  machine: Machine;
  /** Engines with a backend installed, so a row can say what it still needs. */
  installedEngines?: ReadonlySet<string>;
  /** Model ids already installed, so a row can say so rather than offer a repeat. */
  have: Set<string>;
  onDownloaded: () => void | Promise<void>;
}) {
  const [query, setQuery] = useState("");
  /* Seeded from the enabled set, never from a stored preference: which
     registries Karen will contact is a property of the build, not something a
     window can widen. */
  const [sources, setSources] = useState<Set<RegistrySource>>(new Set(ENABLED_SOURCES));
  const [open, setOpen] = useState<string | undefined>();
  const [variants, setVariants] = useState<Record<string, VariantState>>({});
  const [pulling, setPulling] = useState<string | undefined>();
  const [pullError, setPullError] = useState<string | undefined>();
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
  /** Live progress for the download in flight, pushed from the daemon. */
  const [job, setJob] = useState<PullProgress | undefined>();

  const chosen = useMemo(() => ENABLED_SOURCES.filter((s) => sources.has(s)), [sources]);

  /*
   * Progress for the download in flight.
   *
   * Subscribed once and pushed, not polled. `/api/v1/downloads` was the
   * obvious source and is the wrong one: it stays empty for the whole of a
   * `/pull`, because it reports the daemon's own background jobs rather than a
   * transfer somebody is waiting on. The pull itself streams the figures when
   * asked, which is what this receives.
   */
  useEffect(() => window.karen.onPullProgress((p) => setJob(p)), []);

  /** Add or remove one publisher, keeping the rest, and re-run the browse. */
  const toggleAuthor = (who: string): void => {
    const next = authors.includes(who) ? authors.filter((a) => a !== who) : [...authors, who];
    setAuthors(next);
    setQuery("");
    void browse({ authors: next, query: "" });
  };
  const busy = browsing || pulling !== undefined;

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
      setOpen(undefined);
      setVariants({});
      setPullError(undefined);

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

  /**
   * Expand a row into the files it offers.
   *
   * Two sources, because neither covers everything. Lemonade's
   * `/pull/variants` groups a GGUF repository's quantisations and stitches its
   * shards together, which is genuinely useful and worth keeping -- but asked
   * about anything that is not GGUF, ONNX RyzenAI or one of its own Omni
   * collections it answers with a 500. `stabilityai/sd-turbo` is the case that
   * proved it. So a repository whose recipe is not llama.cpp has its files
   * listed from the registry instead.
   */
  const openRepo = useCallback(
    async (model: HfModel, recipe: string): Promise<void> => {
      const source: RegistrySource = ENABLED_SOURCES[0] ?? "huggingface";
      const key = `${source}/${model.id}`;
      if (open === key) {
        setOpen(undefined);
        return;
      }
      setOpen(key);
      if (variants[key]?.data || variants[key]?.files || variants[key]?.loading) return;
      setVariants((v) => ({ ...v, [key]: { loading: true } }));

      if (recipe === "llamacpp") {
        const res = await window.karen.registryVariants(model.id, source);
        setVariants((v) => ({
          ...v,
          [key]: res.ok && res.variants
            ? { loading: false, data: res.variants }
            : { loading: false, error: explainRegistryError(res.error ?? "", source) },
        }));
        return;
      }

      const res = await window.karen.hfFiles(model.id);
      setVariants((v) => ({
        ...v,
        [key]: res.ok && res.files
          ? { loading: false, files: loadableFiles(res.files, recipe) }
          : { loading: false, error: res.error ?? "The file list could not be read." },
      }));
    },
    [open, variants],
  );

  /**
   * Download one file from a repository.
   *
   * Two things here were wrong and are the reason the button never worked.
   *
   * The name had no `user.` prefix, and Lemonade refuses any pull that
   * supplies its own checkpoint without one -- `Registered model definitions
   * must use a non-empty 'user.*' name`. Every download from this page
   * returned a 400.
   *
   * And the recipe came from `/pull/variants`, which reports `llamacpp` for
   * any repository containing `.gguf` files -- diffusion and audio models
   * included. It now comes from what the registry says the model is FOR, which
   * is the only thing that knows the difference.
   */
  const download = async (
    model: HfModel,
    recipe: string,
    file: string | undefined,
    label: string,
  ): Promise<void> => {
    const source: RegistrySource = ENABLED_SOURCES[0] ?? "huggingface";
    const name = pullName(model.id, label);
    setPulling(name);
    setPullError(undefined);
    const res = await window.karen.registryPull(
      name,
      pullCheckpoint(model.id, file),
      source,
      recipe,
    );
    setPulling(undefined);
    if (!res.ok) setPullError(explainRegistryError(res.error ?? "", source));
    else await onDownloaded();
  };

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

        <div className="reg-chips">
          <span className="reg-chips-key">Model makers</span>
          {PUBLISHERS.filter((p) => !p.builder).map((p) => (
            <PublisherChip key={p.author} p={p} on={authors.includes(p.author)} busy={browsing} onPick={toggleAuthor} />
          ))}
        </div>

        {/* Kept apart, because they publish different things and mixing them
            is how a browse ends up empty: Meta publishes no GGUF at all, and
            the Llama builds people actually run come from these four. */}
        <div className="reg-chips">
          <span className="reg-chips-key">GGUF builders</span>
          {PUBLISHERS.filter((p) => p.builder).map((p) => (
            <PublisherChip key={p.author} p={p} on={authors.includes(p.author)} busy={browsing} onPick={toggleAuthor} />
          ))}
        </div>
      </div>

      {pulling ? <DownloadProgress name={pulling} job={job} /> : null}

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

      {pullError ? <p className="reg-line bad">{pullError}</p> : null}

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
            const state = variants[key];
            const isOpen = open === key;
            /* Decided once per row and used for three things: which list of
               files to fetch, which engine the download registers under, and
               whether that engine is present. They must agree, or a repository
               is described by one engine and installed for another. */
            const recipe = recipeFor(model, kindById(kind));
            const can = loadable(model, recipe, installedEngines);
            const words = LOADABLE_WORDS[can];
            const created = age(model.createdAt);
            return (
              <li key={key} className={isOpen ? "reg-hit open" : "reg-hit"}>
                <button
                  type="button"
                  className="reg-hit-head"
                  onClick={() => void openRepo(model, recipe)}
                  aria-expanded={isOpen}
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
                  <span className="reg-hit-open">{isOpen ? "Hide" : "Versions"}</span>
                </button>

                {isOpen ? (
                  <div className="reg-variants">
                    {state?.loading ? (
                      <p className="reg-line">
                        <span className="lem-spinner" aria-hidden="true" />
                        Reading {REGISTRY_NAME[source]}…
                      </p>
                    ) : null}

                    {state?.error ? (
                      <div className="lem-callout">
                        <p className="lem-callout-title">
                          {REGISTRY_LABEL[source]} did not return this repository’s files.
                        </p>
                        <p className="lem-callout-body">{state.error}</p>
                      </div>
                    ) : null}

                    {state?.data ? <VariantList
                      hit={{ id: model.id, source }}
                      data={state.data}
                      machine={machine}
                      have={have}
                      pulling={pulling}
                      onDownload={(name) => {
                        const v = state.data!.variants.find((x) => x.name === name);
                        void download(model, recipe, v?.primaryFile, name);
                      }}
                    /> : null}

                    {/* The registry's own file list, for the kinds Lemonade
                        cannot describe. Plainer than the quantisation list
                        above because there is nothing to group: these are
                        files, and the useful facts are the name and the size. */}
                    {state?.files ? (
                      state.files.length ? (
                        <ul className="reg-vlist">
                          {state.files.map((f) => (
                            <li key={f.path} className="reg-variant">
                              <span className="reg-variant-name">{f.path}</span>
                              <span className="reg-variant-size">{gb(f.sizeBytes)}</span>
                              <button
                                type="button"
                                className="lem-act get"
                                disabled={pulling !== undefined}
                                onClick={() =>
                                  void download(model, recipe, f.path, leafOf(f.path))
                                }
                              >
                                {pulling ? "Downloading…" : "Download"}
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="reg-line">
                          Nothing in this repository is a file the {recipe} engine can load.
                        </p>
                      )
                    ) : null}
                  </div>
                ) : null}
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
 * The quantisations of one repository.
 *
 * This is where the size figure finally becomes exact: the catalogue rounds to
 * whole gigabytes, while `/pull/variants` reports bytes, so the fit verdict on
 * this list is the most accurate one Karen shows anywhere.
 */
function VariantList({
  hit,
  data,
  machine,
  have,
  pulling,
  onDownload,
}: {
  hit: RepoRef;
  data: RepoVariants;
  machine: Machine;
  have: Set<string>;
  pulling: string | undefined;
  onDownload: (name: string) => void;
}) {
  const best = useMemo(() => recommendVariant(data.variants, quantRank), [data.variants]);

  if (!data.variants.length) {
    return <p className="reg-empty">This repository holds no files Karen can run.</p>;
  }

  return (
    <>
      <p className="reg-variants-note">
        {data.variants.length} {data.variants.length === 1 ? "version" : "versions"}, all from{" "}
        <strong className={`reg-inline ${hit.source}`}>{REGISTRY_LABEL[hit.source]}</strong>
        {data.recipe ? <> · runs on {data.recipe}</> : null}
        {data.mmprojFiles.length ? <> · includes a vision projector</> : null}
      </p>
      <ul className="reg-vlist">
        {data.variants.map((v) => {
          const name = modelNameFor(hit.id, v);
          const fit = v.sizeBytes && machine.ramBytes ? fitModel(v.sizeBytes, machine) : undefined;
          const chip = fit ? FIT_CHIP[fit.verdict] : undefined;
          const installed = have.has(name);
          return (
            <li key={v.name} className="reg-variant">
              <span className="reg-variant-name">{v.name}</span>
              {best && v.name === best.name ? (
                <span className="lem-chip accent" title="The usual best balance of size and quality">
                  Recommended
                </span>
              ) : (
                <span className="reg-variant-pad" />
              )}
              <span className="reg-variant-size">{gb(v.sizeBytes)}</span>
              {v.sharded ? (
                <span className="lem-chip dim" title={v.files.join("\n")}>
                  {v.files.length} files
                </span>
              ) : (
                <span className="reg-variant-pad" />
              )}
              {chip ? (
                <span className={`lem-chip ${chip.tone}`} title={fit?.label}>
                  {chip.short}
                </span>
              ) : (
                <span className="lem-chip dim">—</span>
              )}
              <button
                type="button"
                className={installed ? "lem-act" : "lem-act get"}
                disabled={installed || pulling !== undefined}
                onClick={() => onDownload(v.name)}
                title={`Downloads from ${REGISTRY_HOST[hit.source]}`}
              >
                {installed ? "Downloaded" : pulling === name ? "Downloading…" : "Download"}
              </button>
            </li>
          );
        })}
      </ul>
    </>
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

/**
 * What a download is doing, while it does it.
 *
 * Three facts, because each answers a different question a person actually
 * has: how far through (the bar), how big this is (the figures), and whether
 * it is worth waiting for (the rate and the estimate). The estimate is the
 * one most likely to be wrong, so it is derived from the rate the daemon
 * reports right now rather than from an average since the start -- a
 * connection that has just slowed down should say so, not average the slowdown
 * away over twenty minutes.
 */
function DownloadProgress({ name, job }: { name: string; job?: PullProgress | undefined }) {
  const percent = job?.percent ?? 0;
  const done = job?.bytesDone;
  const total = job?.bytesTotal || undefined;

  /* Measured here rather than taken from the daemon, which reports totals but
     not a rate. Two samples a second apart are enough for a figure that is
     about waiting, and the ref keeps the previous one across renders. */
  const last = useRef<{ at: number; bytes: number } | undefined>(undefined);
  const [rate, setRate] = useState<number | undefined>();
  useEffect(() => {
    if (done === undefined) return;
    const now = Date.now();
    const prev = last.current;
    last.current = { at: now, bytes: done };
    if (!prev || now === prev.at) return;
    const perSecond = ((done - prev.bytes) * 1000) / (now - prev.at);
    // Smoothed, or the number flickers unreadably between polls.
    setRate((r) => (r === undefined ? perSecond : r * 0.6 + perSecond * 0.4));
  }, [done]);

  const remaining =
    total !== undefined && done !== undefined && rate !== undefined && rate > 1024
      ? (total - done) / rate
      : undefined;

  return (
    <div className="reg-progress" role="status" aria-live="polite">
      <div className="reg-progress-head">
        {/* The daemon's own name for the file, which is what is actually
            moving; the `user.` prefix Karen has to register under is an
            implementation detail nobody typed and nobody should read. */}
        <span className="reg-progress-name">
          {job?.file || name.replace(/^user\./, "")}
          {job && job.totalFiles > 1 ? ` (${job.fileIndex} of ${job.totalFiles})` : ""}
        </span>
        <span className="reg-progress-figure">
          {total !== undefined ? (
            <>
              {size(done ?? 0)} of {size(total)}
            </>
          ) : (
            "starting…"
          )}
          {rate !== undefined && rate > 1024 ? <> · {size(rate)}/s</> : null}
          {remaining !== undefined ? <> · {duration(remaining)} left</> : null}
        </span>
      </div>
      <div className="lem-bar">
        {/* Indeterminate until the daemon reports a total: a bar pinned at 0%
            reads as "stuck", which is exactly the wrong thing to say while a
            connection is being opened. */}
        <div
          className={total === undefined ? "lem-bar-fill waiting" : "lem-bar-fill"}
          style={total === undefined ? undefined : { width: `${String(percent)}%` }}
        />
      </div>
    </div>
  );
}

/** "3 min 20 s", for a wait rather than a timestamp. */
function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}
