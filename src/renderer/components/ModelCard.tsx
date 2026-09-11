/**
 * One model, as a page.
 *
 * The list this replaced could tell you a repository's name and nothing else.
 * Choosing between `Qwen3-8B-GGUF` and `Qwen3-14B-GGUF`, or between the eleven
 * files inside either, was a decision made from filenames -- and the two facts
 * that actually decide it for an academic user, the **licence** and whether it
 * will **fit on this machine**, were on neither screen.
 *
 * So this page is built around four questions, in the order somebody asks them:
 *
 *   1. What is this and may I use it?   header: licence, publisher, registry
 *   2. Will it run here?                facts strip and the fit column
 *   3. Which file do I take?            the versions table, with plain English
 *   4. What does the author say?        the model card itself
 *
 * Two of MyRA's rules survive the redesign unchanged and are the reason some
 * of this reads the way it does. The registry is named **with its country** in
 * the header, because for many researchers where a model came from is a matter
 * of institutional policy rather than a detail. And opening this page is a
 * network request, so the page says so, in the past tense, once it has happened
 * -- the search box's promise is that nothing is sent until you press Search,
 * and a page that quietly fetched two more things would make that promise
 * false by omission.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { fitModel, quantRank, type Machine } from "../../core/runtime/fit.ts";
import type { RepoDetail } from "../../core/runtime/hfBrowse.ts";
import { age, loadableFiles, pullCheckpoint, pullName, pulledId } from "../../core/runtime/hfBrowse.ts";
import type { PreparedCard } from "../../core/runtime/modelCard.ts";
import { readableName } from "../../core/runtime/modelNames.ts";
import { isDynamic, quantOf } from "../../core/runtime/quants.ts";
import {
  explainRegistryError,
  recommendVariant,
  REGISTRY_HOST,
  REGISTRY_LABEL,
  REGISTRY_NAME,
  type RegistrySource,
  type RepoVariants,
} from "../../core/runtime/registry.ts";
import type { PullProgress } from "../../core/runtime/systemInfo.ts";
import { Markdown } from "./Markdown.tsx";
import { compactNumber, DownloadProgress, FIT_CHIP, gb } from "./modelBits.tsx";

/** What the page needs to know to open, gathered by whoever opened it. */
export interface CardTarget {
  /** `org/name` on the registry. */
  repo: string;
  /** The engine that will run it, decided by the list this came from. */
  recipe: string;
  source: RegistrySource;
}

/** A file offered for download, whichever endpoint described it. */
interface Choice {
  /** What the row is called: `Q4_K_M`, or a filename for a non-GGUF model. */
  label: string;
  /** The file to fetch, when one has to be named. */
  file?: string | undefined;
  sizeBytes?: number | undefined;
  /**
   * The name a pull registers under, and the id the daemon then lists.
   *
   * Two fields for what looks like one fact, because the daemon strips the
   * required `user.` namespace from the id it reports. Both are derived from
   * the same label so they cannot drift; deriving them separately is how the
   * old page ended up offering Download for a model already downloaded.
   */
  pullAs: string;
  installedAs: string;
  /** Sharded builds arrive as several files and the count is worth saying. */
  files?: number | undefined;
}

const EMPTY_SOURCES = new Map<number, never>();

export function ModelCard({
  target,
  machine,
  have,
  pulling,
  job,
  onDownload,
  onBack,
}: {
  target: CardTarget;
  machine: Machine;
  /** Model ids already on this machine, so a row says so rather than repeat. */
  have: Set<string>;
  /** The name of the download in flight, if it is one of these. */
  pulling: string | undefined;
  job: PullProgress | undefined;
  onDownload: (choice: { name: string; checkpoint: string; recipe: string }) => void;
  onBack: () => void;
}) {
  const { repo, recipe, source } = target;
  const [detail, setDetail] = useState<RepoDetail | undefined>();
  const [card, setCard] = useState<PreparedCard | undefined>();
  const [variants, setVariants] = useState<RepoVariants | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  /** Said separately: a repository can have files and no card, and vice versa. */
  const [cardError, setCardError] = useState<string | undefined>();

  /*
   * Everything the page needs, asked for at once.
   *
   * Three requests rather than one because they are three different services --
   * the registry's metadata, the registry's README, and Lemonade's own
   * quantisation grouping -- and because a failure in any one of them should
   * cost only its own section. A card that will not load must not take the
   * download buttons with it.
   */
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(undefined);
    setCardError(undefined);
    setDetail(undefined);
    setCard(undefined);
    setVariants(undefined);

    void (async () => {
      const [detailRes, cardRes, variantRes] = await Promise.all([
        window.myra.hfDetail(repo),
        window.myra.hfCard(repo),
        /* Lemonade groups a GGUF repository's quantisations and stitches its
           shards together, which is genuinely useful and worth keeping -- but
           asked about anything that is not GGUF, ONNX RyzenAI or one of its own
           Omni collections it answers with a 500. `stabilityai/sd-turbo` is the
           case that proved it, so anything else is listed from the registry. */
        recipe === "llamacpp"
          ? window.myra.registryVariants(repo, source)
          : Promise.resolve({ ok: true as const }),
      ]);
      if (!live) return;
      setLoading(false);
      if (detailRes.ok && detailRes.detail) setDetail(detailRes.detail);
      else setError(detailRes.error ?? "The registry did not answer.");
      if (cardRes.ok) setCard(cardRes.card);
      else setCardError(cardRes.error ?? "The model card could not be read.");
      if ("variants" in variantRes && variantRes.variants) setVariants(variantRes.variants);
      else if (!variantRes.ok) {
        setCardError((e) => e ?? explainRegistryError(variantRes.error ?? "", source));
      }
    })();
    return () => {
      live = false;
    };
  }, [repo, recipe, source]);

  /**
   * How well a build of a given size runs here, best first.
   *
   * On the card, then anywhere at all, then not at all. The middle tier is what
   * keeps the badge honest on a machine with no accelerator: without it the
   * recommendation fell back to the fixed preference order and put
   * "Recommended" next to "Too large" on a 30B repository.
   */
  const tier = useCallback(
    (bytes: number): number => {
      if (!machine.ramBytes) return 1;
      const { verdict } = fitModel(bytes, machine);
      return verdict === "gpu" ? 0 : verdict === "too-large" ? Infinity : 1;
    },
    [machine],
  );

  /*
   * The versions, from whichever source could describe them.
   *
   * One list rather than two renderings, so the table, the fit column and the
   * "already downloaded" test are written once. `/pull/variants` gives exact
   * byte sizes and groups shards; the registry's own file list gives paths.
   */
  const choices = useMemo<Choice[]>(() => {
    if (variants?.variants.length) {
      return variants.variants.map((v) => ({
        label: v.name,
        ...(v.primaryFile ? { file: v.primaryFile } : {}),
        ...(v.sizeBytes !== undefined ? { sizeBytes: v.sizeBytes } : {}),
        pullAs: pullName(repo, v.name),
        installedAs: pulledId(repo, v.name),
        ...(v.sharded ? { files: v.files.length } : {}),
      }));
    }
    if (!detail) return [];
    return loadableFiles(detail.files, recipe).map((f) => ({
      label: f.path,
      file: f.path,
      ...(f.sizeBytes !== undefined ? { sizeBytes: f.sizeBytes } : {}),
      pullAs: pullName(repo, leafOf(f.path)),
      installedAs: pulledId(repo, leafOf(f.path)),
    }));
  }, [variants, detail, recipe, repo]);

  const best = useMemo(
    () => (variants ? recommendVariant(variants.variants, quantRank, tier) : undefined),
    [variants, tier],
  );
  /*
   * Whether the recommendation is one this machine could actually run.
   *
   * `recommendVariant` always names something, because the picker needs a
   * default selection -- but where nothing fits, that default is the least-bad
   * of a set of impossibilities, and badging it "Recommended" beside "Too
   * large" is the app recommending a choice that will not work. So the badge
   * is withheld and a sentence says what is actually true instead.
   */
  const bestRuns =
    best?.sizeBytes !== undefined && Number.isFinite(tier(best.sizeBytes));

  /*
   * Which version is selected.
   *
   * Held as a name rather than an index, and reset by the effect below rather
   * than by the picker: the list arrives after the page does, and an index into
   * a list that has not loaded yet selects the wrong thing the moment it has.
   */
  const [chosen, setChosen] = useState<string | undefined>();
  useEffect(() => setChosen(undefined), [repo]);

  /* The recommendation is the default, so the page opens on the answer rather
     than on "choose one of twenty-six". */
  const picked = choices.find((c) => c.label === chosen)
    ?? choices.find((c) => c.label === best?.name)
    ?? choices[0];
  const pickedInstalled = picked !== undefined && have.has(picked.installedAs);
  const pickedFit =
    picked?.sizeBytes && machine.ramBytes ? fitModel(picked.sizeBytes, machine) : undefined;

  const [owner, name] = splitRepo(repo);
  const updated = age(detail?.lastModified);

  return (
    <section className="lem-section card">
      <button type="button" className="card-back" onClick={onBack}>
        ‹ Back to the list
      </button>

      <header className="card-head">
        {/* The name a person would say, with the exact id under it. Both are
            needed and they are not the same job: one is what the model is, the
            other is what somebody checking an institutional policy has to be
            able to read character by character. */}
        <h3 className="card-title">{readableName(repo)}</h3>
        <p className="card-id" title="The repository's exact id on the registry">
          <span className="card-owner">{owner}/</span>
          <span className="card-name">{name}</span>
        </p>
        <div className="card-facts">
          {/* First, and never in a tooltip. Someone checking whether they are
              allowed to use this at all should not have to hover to find out. */}
          <span className={`reg-hit-src ${source}`} title={REGISTRY_NAME[source]}>
            {REGISTRY_LABEL[source]}
          </span>
          {detail?.license ? (
            <span className="lem-chip" title="The licence the publisher declared">
              {detail.license}
            </span>
          ) : loading ? null : (
            <span className="lem-chip dim" title="The publisher did not declare one">
              licence not stated
            </span>
          )}
          {detail?.task ? <span className="card-fact">{detail.task}</span> : null}
          {detail?.downloads !== undefined ? (
            <span className="card-fact" title="Pulls in the last 30 days, automated ones included">
              {compactNumber(detail.downloads)} pulls · 30d
            </span>
          ) : null}
          {detail?.likes !== undefined ? (
            <span className="card-fact" title="People who have starred this repository">
              {compactNumber(detail.likes)} likes
            </span>
          ) : null}
          {updated ? <span className="card-fact">updated {updated}</span> : null}
        </div>
      </header>

      {/* Past tense, and stated once. The search box promises that nothing is
          sent until Search is pressed; a page that silently made two more
          requests would make that promise false by omission. */}
      <p className="reg-egress">
        Opening this asked <strong className={`reg-inline ${source}`}>{REGISTRY_LABEL[source]}</strong>{" "}
        ({REGISTRY_HOST[source]}) for this model’s details and its card. Nothing else was sent.
      </p>

      {detail?.gated ? (
        <div className="lem-callout">
          <p className="lem-callout-title">This model’s licence has to be accepted first.</p>
          <p className="lem-callout-body">
            The publisher gates downloads behind an agreement on their own site. MyRA holds no
            account with the registry, so a download from here will be refused until you have
            accepted it there{detail.licenseLink ? " — the terms are linked below" : ""}.
          </p>
        </div>
      ) : null}

      {pulling ? <DownloadProgress name={pulling} job={job} /> : null}

      {error ? <p className="reg-line bad">{error}</p> : null}
      {loading ? (
        <p className="reg-line">
          <span className="lem-spinner" aria-hidden="true" />
          Reading {REGISTRY_NAME[source]}…
        </p>
      ) : null}

      {/* What decides whether it runs here, on one line. `context_length` is
          the model's trained ceiling and comes free with the metadata; it was
          being fetched and discarded before this page existed. */}
      {detail && (detail.architecture || detail.contextTokens || detail.baseModel) ? (
        <dl className="card-spec">
          {detail.architecture ? (
            <div>
              <dt>Architecture</dt>
              <dd>{detail.architecture}</dd>
            </div>
          ) : null}
          {detail.contextTokens ? (
            <div>
              <dt>Context</dt>
              <dd title="What the model was trained for. MyRA loads a smaller window by default; change it under Tune.">
                {detail.contextTokens.toLocaleString()} tokens
              </dd>
            </div>
          ) : null}
          {detail.baseModel ? (
            <div>
              <dt>Built from</dt>
              <dd>{detail.baseModel}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {choices.length ? (
        <div className="card-versions">
          <h4 className="card-h">
            {variants ? "Version" : "File"}
            <span className="card-h-note">
              {variants
                ? "The same model at different sizes. Smaller is faster and needs less memory; the cost is quality."
                : `The files in this repository that the ${recipe} engine can load.`}
            </span>
          </h4>

          {/*
            * One picker and one button, not a list of twenty-six rows.
            *
            * A repository can offer thirty builds of the same model, and laid
            * out as rows they push the model card two screens down and present
            * thirty Download buttons for a decision where only one of them is
            * wanted. A dropdown makes it what it is: a single choice, with a
            * default already made and the reason for it on screen.
            */}
          <div className="card-pick">
            <label className="card-pick-choice">
              <span className="card-pick-label">Which one</span>
              <select
                value={picked?.label ?? ""}
                onChange={(e) => setChosen(e.target.value)}
                aria-label="Which version to download"
              >
                {choices.map((choice) => (
                  <option key={choice.label} value={choice.label}>
                    {optionLabel(choice, bestRuns ? best?.name : undefined, have)}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className={pickedInstalled ? "lem-act" : "lem-act get"}
              disabled={pickedInstalled || pulling !== undefined || !picked}
              title={`Downloads from ${REGISTRY_HOST[source]}`}
              onClick={() =>
                picked &&
                onDownload({
                  name: picked.pullAs,
                  checkpoint: pullCheckpoint(repo, picked.file),
                  recipe,
                })
              }
            >
              {pickedInstalled
                ? "Downloaded"
                : pulling === picked?.installedAs
                  ? "Downloading…"
                  : "Download"}
            </button>
          </div>

          {variants && !bestRuns && choices.length ? (
            <p className="card-none">
              None of these will run on this machine — the smallest is still larger than its
              memory. MyRA will download one anyway if you want it.
            </p>
          ) : null}

          {/* What the choice above actually means, which is the half a
              filename cannot carry. */}
          {picked ? (
            <div className="card-picked">
              <div className="card-picked-facts">
                <span className="card-picked-size">{gb(picked.sizeBytes)}</span>
                {pickedFit ? (
                  <span className={`lem-chip ${FIT_CHIP[pickedFit.verdict].tone}`} title={pickedFit.label}>
                    {FIT_CHIP[pickedFit.verdict].short}
                  </span>
                ) : null}
                {bestRuns && best && picked.label === best.name ? (
                  <span className="lem-chip accent" title="The usual best balance of size and quality that this machine can hold">
                    Recommended
                  </span>
                ) : null}
                {isDynamic(picked.label) ? (
                  <span className="lem-chip dim" title="Unsloth's dynamic build: the quantisation is chosen per tensor rather than applied uniformly">
                    dynamic
                  </span>
                ) : null}
                {picked.files ? (
                  <span className="lem-chip dim">{picked.files} files</span>
                ) : null}
              </div>
              {quantOf(picked.label)?.note ? (
                <p className="card-picked-note">{quantOf(picked.label)?.note}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : loading ? null : (
        <p className="reg-line">
          Nothing in this repository is a file the {recipe} engine can load.
        </p>
      )}

      <div className="card-readme">
        <h4 className="card-h">
          Model card
          <span className="card-h-note">
            Written by the publisher, shown as they wrote it, without its pictures — the window
            fetches no remote images.
          </span>
        </h4>
        {cardError ? <p className="reg-line bad">{cardError}</p> : null}
        {card ? (
          <>
            <div className="md">
              <Markdown text={card.body} sources={EMPTY_SOURCES as Map<number, never>} />
            </div>
            {card.truncated ? (
              <p className="reg-line">
                This card is longer than MyRA shows. The rest is on the registry’s own page.
              </p>
            ) : null}
          </>
        ) : loading || cardError ? null : (
          <p className="reg-line">This repository has no model card.</p>
        )}
      </div>
    </section>
  );
}

/**
 * One line of a dropdown, carrying the three facts the choice turns on.
 *
 * A `<select>` cannot hold markup, so the name, the size and whether it is
 * already here have to fit in a string. Worth it: the alternative was
 * twenty-six rows of buttons for a single decision.
 */
function optionLabel(choice: Choice, best: string | undefined, have: Set<string>): string {
  const marks = [
    choice.label === best ? "recommended" : undefined,
    have.has(choice.installedAs) ? "downloaded" : undefined,
  ].filter(Boolean);
  return `${choice.label} — ${gb(choice.sizeBytes)}${marks.length ? ` · ${marks.join(" · ")}` : ""}`;
}

/** `unsloth` and `Qwen3-8B-GGUF`, so the publisher can be set back visually. */
function splitRepo(repo: string): [string, string] {
  const at = repo.indexOf("/");
  return at === -1 ? ["", repo] : [repo.slice(0, at), repo.slice(at + 1)];
}

/** `sd_turbo` from `unet/sd_turbo.safetensors`, for a model name. */
function leafOf(path: string): string {
  const leaf = path.split("/").pop() ?? path;
  return leaf.replace(/\.[A-Za-z0-9]+$/, "");
}
