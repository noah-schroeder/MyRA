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
  checkpointFor,
  describeSearch,
  explainRegistryError,
  formatCount,
  mergeHits,
  modelNameFor,
  recommendVariant,
  REGISTRY_HOST,
  REGISTRY_LABEL,
  ENABLED_SOURCES,
  REGISTRY_NAME,
  type RegistryHit,
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

/** What one registry did on the last search, so a failure names itself. */
interface SourceState {
  searching: boolean;
  error?: string;
  /** Asked for, versus what survived lemonade's filtering. */
  fetched?: number;
  shown?: number;
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
  const [status, setStatus] = useState<Partial<Record<RegistrySource, SourceState>>>({});
  const [hits, setHits] = useState<RegistryHit[]>([]);
  const [ran, setRan] = useState<string | undefined>();
  const [open, setOpen] = useState<string | undefined>();
  const [variants, setVariants] = useState<Record<string, VariantState>>({});
  const [pulling, setPulling] = useState<string | undefined>();
  const [pullError, setPullError] = useState<string | undefined>();

  const chosen = useMemo(() => ENABLED_SOURCES.filter((s) => sources.has(s)), [sources]);
  const busy = Object.values(status).some((s) => s?.searching) || pulling !== undefined;

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

  const search = useCallback(async (): Promise<void> => {
    const text = query.trim();
    if (!text || !chosen.length) return;
    setRan(text);
    setOpen(undefined);
    setVariants({});
    setPullError(undefined);
    setStatus(Object.fromEntries(chosen.map((s) => [s, { searching: true }])));

    /* Both registries at once, and settled rather than raced: one being down
       must not discard the other's results, and the pane has to be able to say
       which one failed. */
    const results = await Promise.all(
      chosen.map(async (source) => ({ source, res: await window.karen.registrySearch(text, source) })),
    );

    const next: Partial<Record<RegistrySource, SourceState>> = {};
    const found = [];
    for (const { source, res } of results) {
      if (res.ok && res.result) {
        next[source] = { searching: false, fetched: res.result.fetched, shown: res.result.hits.length };
        found.push(res.result);
      } else {
        next[source] = {
          searching: false,
          error: explainRegistryError(res.error ?? "", source),
        };
      }
    }
    setStatus(next);
    setHits(mergeHits(found));
  }, [query, chosen]);

  const openRepo = useCallback(
    async (hit: RegistryHit): Promise<void> => {
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

  const download = async (hit: RegistryHit, data: RepoVariants, name: string): Promise<void> => {
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
              if (e.key === "Enter") void search();
            }}
            aria-label="Search the model registries"
          />
          <button
            type="button"
            className="reg-go"
            disabled={busy || !query.trim() || !chosen.length}
            onClick={() => void search()}
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
              Pressing Search sends “{query.trim() || "…"}” to{" "}
              {chosen.map((s, i) => (
                <span key={s}>
                  {i > 0 ? " and " : ""}
                  <strong className={`reg-inline ${s}`}>{REGISTRY_LABEL[s]}</strong>
                </span>
              ))}
              . Typing sends nothing.
            </>
          )}
        </p>
      </div>

      {/* ---------------- what each registry said ---------------- */}
      {ran ? (
        <div className="reg-report">
          {chosen.map((source) => {
            const st = status[source];
            if (!st) return null;
            return (
              <p key={source} className={st.error ? "reg-line bad" : "reg-line"}>
                <span className={`reg-tag ${source}`}>{REGISTRY_LABEL[source]}</span>
                {st.searching ? (
                  <>searching…</>
                ) : st.error ? (
                  <>{st.error}</>
                ) : (
                  /* Written by `describeSearch` rather than assembled here,
                     because the two registries mean different things by their
                     count and only one of them supports "the rest are formats
                     Karen cannot run". */
                  <>{describeSearch(st.shown ?? 0, st.fetched ?? st.shown ?? 0)}</>
                )}
              </p>
            );
          })}
        </div>
      ) : null}

      {pullError ? <p className="reg-line bad">{pullError}</p> : null}

      {/* ---------------- results ---------------- */}
      {hits.length ? (
        <ul className="reg-hits">
          {hits.map((hit) => {
            const key = `${hit.source}/${hit.id}`;
            const state = variants[key];
            const isOpen = open === key;
            return (
              <li key={key} className={isOpen ? "reg-hit open" : "reg-hit"}>
                <button
                  type="button"
                  className="reg-hit-head"
                  onClick={() => void openRepo(hit)}
                  aria-expanded={isOpen}
                >
                  <span className={`reg-tag ${hit.source}`}>{REGISTRY_LABEL[hit.source]}</span>
                  <span className="reg-hit-id">
                    <span className="reg-hit-name">{hit.id}</span>
                    {/* A registry's own display name can differ from the
                        repository path, and can be in another language;
                        showing both is how someone recognises the model they
                        already know. */}
                    {hit.name && hit.name !== hit.id.split("/").pop() ? (
                      <span className="reg-hit-alt">{hit.name}</span>
                    ) : null}
                  </span>
                  {hit.hasGguf ? <span className="lem-chip good">GGUF</span> : (
                    <span className="lem-chip dim" title="No GGUF files; Karen may not be able to run this">
                      no GGUF
                    </span>
                  )}
                  <span className="reg-hit-figure" title="Downloads">
                    ↓ {formatCount(hit.downloads)}
                  </span>
                  <span className="reg-hit-figure" title="Likes">
                    ♥ {formatCount(hit.likes)}
                  </span>
                  <span className="reg-hit-open">{isOpen ? "Hide" : "Versions"}</span>
                </button>

                {isOpen ? (
                  <div className="reg-variants">
                    {state?.loading ? (
                      <p className="reg-line">
                        <span className="lem-spinner" aria-hidden="true" />
                        Reading {REGISTRY_NAME[hit.source]}…
                      </p>
                    ) : null}

                    {state?.error ? (
                      <div className="lem-callout">
                        <p className="lem-callout-title">
                          {REGISTRY_LABEL[hit.source]} did not return this repository’s files.
                        </p>
                        <p className="lem-callout-body">{state.error}</p>
                      </div>
                    ) : null}

                    {state?.data ? <VariantList
                      hit={hit}
                      data={state.data}
                      machine={machine}
                      have={have}
                      pulling={pulling}
                      onDownload={(name) => void download(hit, state.data!, name)}
                    /> : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {ran && !hits.length && !busy && !Object.values(status).some((s) => s?.error) ? (
        <p className="reg-empty">
          Nothing usable for “{ran}”. Registry search matches repository names rather than
          descriptions, so a single word — a family or an organisation — finds more than a phrase.
        </p>
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
  hit: RegistryHit;
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
