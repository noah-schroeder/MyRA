import { useEffect, useRef, useState } from "react";
import {
  activeCount, anyFailed, fraction, statusLine, type Download,
} from "../../core/downloads/download.ts";

/**
 * Model downloads, wherever you happen to be looking.
 *
 * A model is gigabytes and an hour, so the thing you do while it arrives is
 * everything else -- which is exactly what used to make it disappear. The
 * transfer never stopped; it lives in the main process. But the progress bar
 * lived in the models page, so leaving that page took the only evidence with
 * it, and there was no way to stop one on purpose from anywhere.
 *
 * Three surfaces over one list, which is held in main:
 *
 *   - a **toast**, bottom right, for the one you just started. Dismissable,
 *     because a bar that cannot be put away is a bar that owns the corner of
 *     the screen for an hour.
 *   - a **counter** in the top bar, which is where it goes when you dismiss
 *     the toast, so putting it away is never the same as losing it.
 *   - the **panel** under that counter, with pause, resume and cancel.
 */

/** Subscribed once, at the top of the app. The list is pushed, never polled. */
export function useDownloads(): Download[] {
  const [list, setList] = useState<Download[]>([]);
  useEffect(() => {
    void window.myra.downloadsList().then(setList).catch(() => {});
    return window.myra.onDownloads(setList);
  }, []);
  return list;
}

/* ------------------------------------------------------------------ *
 * One row                                                             *
 * ------------------------------------------------------------------ */

function Row({ d, onAct }: { d: Download; onAct: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const part = fraction(d);

  const cancel = async (): Promise<void> => {
    setConfirming(false);
    await window.myra.downloadCancel(d.id);
    onAct();
  };

  return (
    <li className={`dl-row dl-${d.state}`}>
      <div className="dl-head">
        <span className="dl-name" title={d.checkpoint}>
          {d.label}
        </span>
        <span className="dl-pct">
          {part === undefined ? "" : `${Math.round(part * 100)}%`}
        </span>
      </div>

      {/* Indeterminate until the daemon has told us the size, rather than a
          bar sitting at zero: the first seconds of a pull are a repository
          listing, and a still bar there reads as a stall. */}
      <div className={part === undefined && d.state === "running" ? "dl-bar dl-bar-wait" : "dl-bar"}>
        <span className="dl-fill" style={part === undefined ? undefined : { width: `${part * 100}%` }} />
      </div>

      <p className="dl-status">{statusLine(d)}</p>

      {confirming ? (
        <div className="dl-confirm">
          {/* Said plainly, because this is the one button here that destroys
              something. */}
          <span>Delete what has downloaded so far?</span>
          <button type="button" className="dl-danger" onClick={() => void cancel()}>
            Delete
          </button>
          <button type="button" onClick={() => setConfirming(false)}>
            Keep
          </button>
        </div>
      ) : (
        <div className="dl-actions">
          {d.state === "running" ? (
            <button type="button" onClick={() => void window.myra.downloadPause(d.id)}>
              Pause
            </button>
          ) : null}
          {d.state === "paused" ? (
            <button type="button" onClick={() => void window.myra.downloadResume(d.id)}>
              Resume
            </button>
          ) : null}
          {d.state === "running" || d.state === "paused" ? (
            <button type="button" className="dl-quiet" onClick={() => setConfirming(true)}>
              Cancel
            </button>
          ) : (
            <button
              type="button"
              className="dl-quiet"
              onClick={() => void window.myra.downloadDismiss(d.id)}
            >
              Dismiss
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * The counter and its panel                                           *
 * ------------------------------------------------------------------ */

export function DownloadsButton({ list }: { list: Download[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const active = activeCount(list);
  const failed = anyFailed(list);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  /* Nothing at all when there is nothing to say. A permanently visible
     downloads icon on an app that downloads a model twice a year is a
     control that is wrong about its own importance. */
  if (list.length === 0) return null;

  return (
    <div className="dl-button-box" ref={box}>
      <button
        type="button"
        className={failed ? "dl-button dl-button-warn" : "dl-button"}
        aria-label={`Downloads (${active} in progress)`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3v12" />
          <path d="m7 11 5 5 5-5" />
          <path d="M4 20h16" />
        </svg>
        {active > 0 ? <span className="dl-count">{active}</span> : null}
      </button>

      {open ? (
        <div className="dl-panel" role="dialog" aria-label="Downloads">
          <div className="dl-panel-head">
            <span>Downloads</span>
            {list.some((d) => d.state === "done" || d.state === "failed") ? (
              <button
                type="button"
                className="dl-quiet"
                onClick={() => void window.myra.downloadDismiss()}
              >
                Clear finished
              </button>
            ) : null}
          </div>
          <ul className="dl-rows">
            {list.map((d) => (
              <Row key={d.id} d={d} onAct={() => undefined} />
            ))}
          </ul>
          {/* The one thing a person cannot work out from the bars, and the
              thing that makes leaving the page safe. */}
          <p className="dl-foot">
            These keep going while you work elsewhere, and stop if you quit MyRA.
            A paused or interrupted download resumes where it left off.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The toast                                                           *
 * ------------------------------------------------------------------ */

/**
 * How much room the composer is taking at the bottom right, if any.
 *
 * The toast is bottom-right and so is the send button, so a fixed offset put
 * one on top of the other -- and it could not be a constant anyway, because
 * the composer grows as you type. Measured rather than guessed, and zero on
 * every page where the composer is hidden.
 */
function useComposerHeight(active: boolean): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!active) return;
    const composer = document.querySelector(".composer");
    if (!composer) return;
    const measure = (): void =>
      setHeight((composer as HTMLElement).hidden ? 0 : composer.getBoundingClientRect().height);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(composer);
    /* `hidden` toggling is an attribute change, which a ResizeObserver does
       not see when the size is unchanged -- and switching page is exactly
       that. */
    const mo = new MutationObserver(measure);
    mo.observe(composer, { attributes: true, attributeFilter: ["hidden"] });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [active]);
  return height;
}

export function DownloadToast({ list }: { list: Download[] }) {
  /*
   * Dismissal is per download, not a single "hide the toast" flag.
   *
   * With one flag, closing the toast for a model that then finished would
   * leave the next download you started silently invisible -- and the whole
   * complaint being answered here is downloads that are happening with nothing
   * on screen to say so.
   */
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const shown = list.filter((d) => !hidden.has(d.id) && d.state !== "done");

  /* Forget the ones that have gone, so the set does not grow for the life of
     the session and a re-download of the same id starts visible. */
  useEffect(() => {
    setHidden((seen) => {
      const live = new Set(list.map((d) => d.id));
      const next = new Set([...seen].filter((id) => live.has(id)));
      return next.size === seen.size ? seen : next;
    });
  }, [list]);

  const lift = useComposerHeight(shown.length > 0);

  if (shown.length === 0) return null;

  return (
    <div
      className="dl-toast"
      role="status"
      aria-label="Downloading"
      style={{ bottom: `${lift + 18}px` }}
    >
      <ul className="dl-rows">
        {shown.map((d) => (
          <li key={d.id} className="dl-toast-item">
            <button
              type="button"
              className="dl-toast-close"
              aria-label={`Hide ${d.label}`}
              title="Hide — it keeps downloading, and stays under the arrow above"
              onClick={() => setHidden((seen) => new Set(seen).add(d.id))}
            >
              ×
            </button>
            <Row d={d} onAct={() => undefined} />
          </li>
        ))}
      </ul>
    </div>
  );
}
