/**
 * The pieces the model list, the model card and the catalogue all draw.
 *
 * Extracted when the card became its own screen and the third copy of `gb` was
 * about to be written. Sizes and fit verdicts appear in four places on the
 * Models page and have to agree: "4.9 GB" beside "Fits on GPU" on one screen
 * and "4.88 GB" beside "Part on GPU" on another is a difference a person will
 * try to explain rather than dismiss.
 */

import { useEffect, useRef, useState } from "react";

import { hasTools, hasVision } from "../../core/models/roles.ts";
import type { Verdict } from "../../core/runtime/fit.ts";
import type { PullProgress } from "../../core/runtime/systemInfo.ts";

/**
 * Vision and tool-calling, as icons rather than words.
 *
 * Both are already sayable as text -- `LemonadePane`'s `LABEL_WORDS` spells
 * them "Reads images" and "Tools" -- but a model list that also shows
 * "Reasoning", "Code" and half a dozen other labels only has room to show a
 * few of them before a `.slice(...)` cuts the rest, and vision or tool-calling
 * is exactly the fact that must not be the one dropped: it decides whether an
 * attached image or a tool call does anything at all. So these two get a
 * fixed, always-shown slot of their own on every list a chat model appears in.
 */
export function CapabilityIcons({ labels }: { labels: readonly string[] | undefined }) {
  const vision = hasVision(labels);
  const tools = hasTools(labels);
  if (!vision && !tools) return null;
  return (
    <span className="cap-icons">
      {vision ? (
        <span className="cap-icon" title="Reads images and documents" aria-label="Vision">
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
            <path
              d="M1 8s2.6-4.5 7-4.5 7 4.5 7 4.5-2.6 4.5-7 4.5S1 8 1 8Z"
              fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"
            />
            <circle cx="8" cy="8" r="1.7" fill="currentColor" />
          </svg>
        </span>
      ) : null}
      {tools ? (
        <span className="cap-icon" title="Can call tools" aria-label="Tool calling">
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
            <path
              d="M11.8 2.3a2.9 2.9 0 0 0-3.6 3.6L2.7 11.4a1 1 0 0 0 1.4 1.4L9.6 7.3a2.9 2.9 0 0 0 3.6-3.6l-1.9 1.9-1.4-1.4Z"
              fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round"
            />
          </svg>
        </span>
      ) : null}
    </span>
  );
}

export const FIT_CHIP: Record<Verdict, { short: string; tone: string }> = {
  gpu: { short: "Fits on GPU", tone: "good" },
  partial: { short: "Part on GPU", tone: "warn" },
  cpu: { short: "Processor", tone: "dim" },
  "too-large": { short: "Too large", tone: "bad" },
};

/** A model's size on disk, in the unit a column of models reads best in. */
export function gb(bytes?: number | undefined): string {
  return bytes ? `${(bytes / 1024 ** 3).toFixed(bytes < 1024 ** 3 ? 2 : 1)} GB` : "—";
}

/**
 * A size in the unit that shows movement.
 *
 * `gb` renders everything in gigabytes, which is right in a column of model
 * sizes and useless on a progress line: a 310 MB download spends its whole
 * life reading "0.00 GB of 0.31 GB". Below a gigabyte this switches to
 * megabytes, and below a megabyte to kilobytes, so the number always changes
 * while bytes are actually arriving.
 */
export function size(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} kB`;
}

/** "3 min 20 s", for a wait rather than a timestamp. */
export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

/** A count as a person would say it: 80816 → "81k". */
export function compactNumber(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
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
export function DownloadProgress({ name, job }: { name: string; job?: PullProgress | undefined }) {
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
            moving; the `user.` prefix MyRA has to register under is an
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
