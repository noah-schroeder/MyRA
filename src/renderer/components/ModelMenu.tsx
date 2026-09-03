import type { ModelOption, AudioProgress } from "../types.ts";
import { shortModelName as shorten } from "../../core/runtime/foreign.ts";
import { modelNamer } from "../../core/models/roles.ts";
import { runnable, type Runnable } from "../../core/runtime/runnable.ts";

/**
 * The body of a model dropdown: what is here, what could be downloaded, and
 * what each provider offers.
 *
 * Extracted when the image picker became the third control needing exactly
 * this list. There were already two copies -- the chat bar's audio pickers and
 * the Audio pane in Settings -- and a third would have made the grouping rules
 * something nobody could change in one place. What is NOT here is the button,
 * the icon, the copy or the footer: those are what make the pickers different
 * controls rather than one control with a role switch, and merging them would
 * have been the more expensive mistake.
 *
 * The sections are ordered as a recommendation: loaded, downloaded, available,
 * then whatever leaves the machine.
 */

export function gb(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

export function ModelMenu({
  options,
  chosen,
  busy,
  progress,
  error,
  emptyText,
  engines,
  externalWarning,
  footer,
  onChoose,
}: {
  options: ModelOption[];
  chosen: string;
  /**
   * What each engine can do on this machine, when the daemon has been asked.
   *
   * Empty is "not known yet" and shows nothing: a picker that guessed would be
   * warning about engines it had not checked. When it IS known, a model whose
   * engine is not installed says so on the row, because the alternative is what
   * happened to a user -- a 1.6 GB Whisper download, chosen from a list that
   * said nothing, failing at the end of the first dictated sentence.
   */
  engines?: Map<string, Runnable>;
  /** The ref currently downloading or loading, if any. */
  busy: string | undefined;
  progress: AudioProgress | undefined;
  error: string | undefined;
  /** Shown when there is nothing at all to offer. */
  emptyText: string;
  /** What to say above a provider group that leaves this machine. */
  externalWarning: string;
  footer: React.ReactNode;
  onChoose: (option: ModelOption) => void;
}) {
  const locals = options.filter((o) => o.where === "local");
  const downloaded = locals.filter((o) => o.downloaded);
  const available = locals.filter((o) => !o.downloaded);
  const providers = options.filter((o) => o.where === "provider");
  const byProvider = new Map<string, ModelOption[]>();
  for (const option of providers) {
    const key = option.providerLabel ?? "Provider";
    byProvider.set(key, [...(byProvider.get(key) ?? []), option]);
  }

  const name = modelNamer(options.map((o) => o.model), shorten);

  /* Only ever "not installed", never "unsupported": an engine this machine
     cannot run at all is the Models screen's business, and a chat bar menu is
     not where somebody should learn their GPU is the wrong one. */
  const needsEngine = (option: ModelOption): boolean =>
    Boolean(
      engines?.size && option.where === "local" && option.recipe &&
        runnable(option.recipe, engines).state === "needs-engine",
    );

  const row = (option: ModelOption): React.JSX.Element => {
    const on = option.ref === chosen;
    const loading = busy === option.ref;
    return (
      <li key={option.ref} className="modelmenu-row">
        <button
          type="button"
          role="menuitem"
          className={on ? "modelmenu-item active" : "modelmenu-item"}
          disabled={Boolean(busy)}
          onClick={() => onChoose(option)}
        >
          <span className="modelmenu-name">{name(option.model)}</span>
          <span className="modelmenu-meta">
            {loading && progress?.bytesTotal
              ? `${Math.round(progress.percent)}%`
              : option.sizeBytes
                ? gb(option.sizeBytes)
                : null}
            {loading ? (
              <span className="pill warn">{progress?.bytesTotal ? "downloading" : "loading"}</span>
            ) : null}
            {!loading && option.loaded ? <span className="pill on">loaded</span> : null}
            {!loading && !option.loaded && option.downloaded === false ? (
              <span className="pill">download</span>
            ) : null}
            {!loading && needsEngine(option) ? (
              <span className="pill warn">needs {option.recipe}</span>
            ) : null}
          </span>
        </button>
      </li>
    );
  };

  return (
    <div className="modelmenu" role="menu">
      {downloaded.length ? (
        <>
          <p className="modelmenu-head">On this machine</p>
          <ul className="modelmenu-list">{downloaded.map(row)}</ul>
        </>
      ) : null}

      {available.length ? (
        <>
          <p className="modelmenu-head">
            {downloaded.length ? "Available to download" : "Download one to get started"}
          </p>
          <ul className="modelmenu-list">{available.map(row)}</ul>
        </>
      ) : null}

      {[...byProvider].map(([provider, models]) => (
        <div key={provider}>
          <p className="modelmenu-head">{provider}</p>
          {models.some((m) => m.external) ? (
            <p className="modelmenu-warn" role="note">
              {externalWarning}
            </p>
          ) : null}
          <ul className="modelmenu-list">{models.map(row)}</ul>
        </div>
      ))}

      {options.length === 0 ? <p className="modelmenu-empty">{error ?? emptyText}</p> : null}
      {error && options.length ? <p className="modelmenu-empty">{error}</p> : null}

      <div className="modelmenu-foot">{footer}</div>
    </div>
  );
}
