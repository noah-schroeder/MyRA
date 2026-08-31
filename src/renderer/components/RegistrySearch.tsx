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

import { fitModel, quantRank, type Machine, type Verdict } from "../../core/runtime/fit.ts";
import {
  age, compact, describeDownloads, KINDS, kindById, loadable, LOADABLE_WORDS,
  PUBLISHERS, publisherNote, SORTS, type BrowseSort, type HfModel,
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
  data?: RepoVariants;
}

export function RegistrySearch({
  machine,
  have,
  onDownloaded,
}: {
  machine: Machine;
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
  const [author, setAuthor] = useState<string | undefined>();
  const [sort, setSort] = useState<BrowseSort>("downloads");
  const [ggufOnly, setGgufOnly] = useState(true);
  const [models, setModels] = useState<HfModel[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | undefined>();
  const [ranBrowse, setRanBrowse] = useState<string | undefined>();

  const chosen = useMemo(() => ENABLED_SOURCES.filter((s) => sources.has(s)), [sources]);
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
      author?: string | undefined;
      sort?: BrowseSort;
      ggufOnly?: boolean;
      query?: string;
    } = {}): Promise<void> => {
      const next = {
        kind: patch.kind ?? kind,
        author: "author" in patch ? patch.author : author,
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
        ...(next.author ? { author: next.author } : {}),
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
        next.author ? `from ${next.author}` : undefined,
        next.query.trim() ? `matching “${next.query.trim()}”` : undefined,
      ].filter(Boolean);
      setRanBrowse(parts.join(" "));
    },
    [kind, author, sort, ggufOnly, query],
  );

  const openRepo = useCallback(
    async (hit: { id: string; source: RegistrySource }): Promise<void> => {
      const key = `${hit.source}/${hit.id}`;
      if (open === key) {
        setOpen(undefined);
        return;
      }
      setOpen(key);
      if (variants[key]?.data || variants[key]?.loading) return;
      setVariants((v) => ({ ...v, [key]: { loading: true } }));
      const res = await window.karen.registryVariants(hit.id, hit.source);
      setVariants((v) => ({
        ...v,
        [key]: res.ok && res.variants
          ? { loading: false, data: res.variants }
          : { loading: false, error: explainRegistryError(res.error ?? "", hit.source) },
      }));
    },
    [open, variants],
  );

  const download = async (hit: RepoRef, data: RepoVariants, name: string): Promise<void> => {
    const variant = data.variants.find((v) => v.name === name);
    if (!variant) return;
    const modelName = modelNameFor(hit.id, variant);
    setPulling(modelName);
    setPullError(undefined);
    const res = await window.karen.registryPull(
      modelName,
      checkpointFor(hit.id, variant),
      hit.source,
      data.recipe,
    );
    setPulling(undefined);
    if (!res.ok) setPullError(explainRegistryError(res.error ?? "", hit.source));
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
                setKind(k.id);
                void browse({ kind: k.id });
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
            Only models Karen can run
          </label>

          {author ? (
            <button
              type="button"
              className="reg-chip on"
              disabled={browsing}
              onClick={() => {
                setAuthor(undefined);
                void browse({ author: undefined });
              }}
            >
              {author} ✕
            </button>
          ) : null}
        </div>

        <div className="reg-chips">
          <span className="reg-chips-key">Model makers</span>
          {PUBLISHERS.filter((p) => !p.builder).map((p) => (
            <button
              key={p.author}
              type="button"
              className={author === p.author ? "reg-chip small on" : "reg-chip small"}
              disabled={browsing}
              title={`Everything published by ${p.author}`}
              onClick={() => {
                setAuthor(p.author);
                setQuery("");
                void browse({ author: p.author, query: "" });
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Kept apart, because they publish different things and mixing them
            is how a browse ends up empty: Meta publishes no GGUF at all, and
            the Llama builds people actually run come from these four. */}
        <div className="reg-chips">
          <span className="reg-chips-key">GGUF builders</span>
          {PUBLISHERS.filter((p) => p.builder).map((p) => (
            <button
              key={p.author}
              type="button"
              className={author === p.author ? "reg-chip small on" : "reg-chip small"}
              disabled={browsing}
              title={`Everything published by ${p.author}`}
              onClick={() => {
                setAuthor(p.author);
                setQuery("");
                void browse({ author: p.author, query: "" });
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
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
          {ggufOnly ? ", limited to repositories Karen can run" : ", including ones Karen cannot run"}.
          {kind === "all" ? null : <> {kindById(kind).hint}</>}
        </p>
      ) : null}

      {pullError ? <p className="reg-line bad">{pullError}</p> : null}

      {/* ---------------- results ---------------- */}
      {!browsing && ranBrowse && !models.length && !browseError ? (
        <div className="lem-callout">
          <p className="lem-callout-title">Nothing here.</p>
          <p className="lem-callout-body">
            {publisherNote(author) ??
              (author && kind !== "all"
                ? `${author} publishes no ${kindById(kind).title.toLowerCase()} models. Clear the publisher, or choose another kind.`
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
            const can = loadable(model, kindById(kind));
            const words = LOADABLE_WORDS[can];
            const created = age(model.createdAt);
            return (
              <li key={key} className={isOpen ? "reg-hit open" : "reg-hit"}>
                <button
                  type="button"
                  className="reg-hit-head"
                  onClick={() => void openRepo({ id: model.id, source })}
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
                      onDownload={(name) => void download({ id: model.id, source }, state.data!, name)}
                    /> : null}
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
