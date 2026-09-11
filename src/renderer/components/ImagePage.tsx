import { useCallback, useEffect, useRef, useState } from "react";
import type { ImageRecord, Settings } from "../types.ts";
import { IMAGE_PRESETS, LETTERING_WARNING, presetById } from "../../core/images/presets.ts";
import { IMAGE_SIZES } from "../../core/images/sizes.ts";
import { shortModelName as shorten } from "../../core/runtime/foreign.ts";
import { parseModelRef } from "../../core/providers.ts";

/**
 * Making pictures, on the machine that will keep them.
 *
 * Built as a page rather than a panel over the conversation for the reason
 * Meetings is: these have a past. What you made last week is the point of
 * having made it, and a strip above the thread could only ever show the one
 * being drawn right now.
 *
 * Two things about the shape are deliberate.
 *
 * The composer sits at the bottom and holds everything that describes ONE
 * generation -- the prompt, what to avoid, the preset, the size -- while the
 * model lives in the bar at the top, because the model is a setting that
 * outlives the picture and the rest is not.
 *
 * And the presets are applied at send time, never by editing the box. The
 * scaffold is style, the typed words are subject, and composing them here
 * means switching preset after typing cannot duplicate a scaffold, strand half
 * of one in the textarea, or leave the user unable to see what they actually
 * wrote. See core/images/presets.ts.
 */

/* Object URLs, kept for the life of the window rather than revoked per render:
   a tile that revoked its own URL on unmount would go blank the moment the
   grid re-flowed, and these are the same bytes either way. */
const urls = new Map<string, string>();

function urlFor(id: string, bytes: Uint8Array, mime: string): string {
  const existing = urls.get(id);
  if (existing) return existing;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  urls.set(id, url);
  return url;
}

function when(iso: string): string {
  if (!iso) return "";
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleString();
}

export function ImagePage({
  settings,
  onSettingsChange,
  onClose,
}: {
  settings: Settings;
  onSettingsChange: (s: Settings) => void;
  onClose: () => void;
}) {
  const [images, setImages] = useState<ImageRecord[]>([]);
  const [shown, setShown] = useState<ImageRecord | undefined>();
  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [preset, setPreset] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | undefined>();
  const box = useRef<HTMLTextAreaElement>(null);

  const refresh = useCallback(async (): Promise<ImageRecord[]> => {
    const result = await window.myra.imageList();
    setImages(result.images);
    return result.images;
  }, []);

  useEffect(() => {
    void refresh().then((list) => setShown((current) => current ?? list[0]));
  }, [refresh]);

  /*
   * Elapsed seconds, not a filling bar.
   *
   * This route reports no step count, so a progress bar would be an invented
   * number -- the same judgement the model loader makes. The striped bar says
   * "still working" and the seconds beside it say how long, which between them
   * are the two things a person waiting actually wants.
   */
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 250);
    return () => clearInterval(timer);
  }, [busy]);

  const model = settings.image.model;
  const chosenPreset = presetById(preset);

  const generate = async (): Promise<void> => {
    const typed = prompt.trim();
    if (!typed || busy) return;
    setError(undefined);
    setBusy(true);
    const result = await window.myra.imageGenerate({
      prompt: typed,
      ...(negative.trim() ? { negative: negative.trim() } : {}),
      ...(preset ? { preset } : {}),
    });
    setBusy(false);
    if (!result.ok || !result.record) {
      setError(result.error ?? "The image could not be made.");
      return;
    }
    if (result.image) urlFor(result.record.id, result.image, result.record.mime);
    setShown(result.record);
    /* The prompt stays in the box. You refine a picture by editing what you
       asked for, and clearing it after every generation would mean retyping
       the whole thing to change one word. */
    await refresh();
  };

  const remove = async (record: ImageRecord): Promise<void> => {
    const result = await window.myra.imageDelete(record.id);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    urls.delete(record.id);
    const list = await refresh();
    setShown((current) => (current?.id === record.id ? list[0] : current));
  };

  return (
    <section className="images">
      <header className="hub-head">
        <div className="hub-title">
          <h1>Images</h1>
          <p>Make figures and illustrations, and keep them in a folder you own.</p>
        </div>
        <div className="hub-stats">
          <div className="hub-stat">
            <span className="hub-stat-value">
              {model ? shorten(parseModelRef(model).model) : "not set up"}
            </span>
            <span className="hub-stat-label">Model</span>
          </div>
          <div className="hub-stat">
            <span className="hub-stat-value">{String(images.length)}</span>
            <span className="hub-stat-label">Saved</span>
          </div>
        </div>
        <button type="button" className="hub-back" onClick={onClose}>
          Back to chat
        </button>
      </header>

      {!model ? (
        <p className="hub-alert note" role="status">
          No image model is chosen yet. Pick one from the model bar above — a local one will be
          downloaded the first time you use it.
        </p>
      ) : null}

      <div className="images-body">
        <div className="image-stage">
          {shown ? (
            <Shown
              record={shown}
              onDelete={() => void remove(shown)}
              onReuse={(r) => {
                /* Exactly what was typed, not what was sent: the preset is put
                   back alongside it and will add its own terms again. */
                setPrompt(r.prompt);
                setNegative(r.negative);
                setPreset(r.preset);
                box.current?.focus();
              }}
            />
          ) : (
            <p className="runs-empty">
              Nothing made yet. Describe a picture below and it will appear here — and stay in
              your images folder afterwards, next to a note of what it was asked for.
            </p>
          )}
        </div>

        {images.length > 1 ? (
          <>
            <p className="image-gallery-head">Earlier</p>
            <ul className="image-gallery">
              {images.map((record) => (
                <li key={record.id}>
                  <button
                    type="button"
                    className={record.id === shown?.id ? "image-tile on" : "image-tile"}
                    title={record.prompt}
                    onClick={() => setShown(record)}
                  >
                    <Thumb record={record} />
                    <span className="image-tile-label">{record.prompt || "untitled"}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>

      <footer className="composer image-composer">
        <div className="composer-card">
          {error ? <p className="error" role="alert">{error}</p> : null}

          <textarea
            ref={box}
            className="input"
            rows={2}
            placeholder="Describe the picture — what is in it, and how it should look."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void generate();
              }
            }}
          />

          <div className="image-presets" role="group" aria-label="Style">
            {IMAGE_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={preset === p.id ? "chip active" : "chip"}
                title={p.hint}
                aria-pressed={preset === p.id}
                onClick={() => setPreset((current) => (current === p.id ? undefined : p.id))}
              >
                {p.label}
              </button>
            ))}
          </div>

          {chosenPreset ? <p className="image-hint dim">{chosenPreset.hint}</p> : null}
          {/* Said out loud rather than discovered. These models draw the shape
              of text, so the one thing a figure needs most is the one thing
              this cannot do, and a preset row that stayed quiet about it would
              be a row of buttons that silently disappoint. */}
          <p className="image-hint warn" role="note">{LETTERING_WARNING}</p>

          <div className="composer-tools image-tools">
            <input
              className="image-negative"
              type="text"
              placeholder="Avoid… (optional)"
              value={negative}
              onChange={(e) => setNegative(e.target.value)}
            />
            <label className="image-size">
              <span className="dim">Size</span>
              <select
                value={settings.image.size}
                onChange={(e) => {
                  const size = e.target.value;
                  void window.myra
                    .updateSettings({ image: { ...settings.image, size } })
                    .then(onSettingsChange);
                }}
              >
                {IMAGE_SIZES.map((size) => (
                  <option key={size.id} value={size.id} title={size.hint}>
                    {size.label}
                  </option>
                ))}
              </select>
            </label>

            <span className="composer-spacer" />

            {busy ? (
              <>
                <span className="dim">{elapsed}s</span>
                <button type="button" onClick={() => void window.myra.imageCancel()}>
                  Stop
                </button>
              </>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={!prompt.trim() || !model}
                title={model ? "" : "Choose an image model first."}
                onClick={() => void generate()}
              >
                Generate
              </button>
            )}
          </div>

          {busy ? (
            <div className="modelbar-progress" role="progressbar" aria-label="Making the image">
              <span className="modelbar-progress-run" />
            </div>
          ) : null}
        </div>
      </footer>
    </section>
  );
}

/* ------------------------------------------------------------ one picture -- */

function Shown({
  record,
  onDelete,
  onReuse,
}: {
  record: ImageRecord;
  onDelete: () => void;
  onReuse: (record: ImageRecord) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const url = useBytes(record);

  useEffect(() => setConfirming(false), [record.id]);

  return (
    <figure className="image-shown">
      {url ? <img src={url} alt={record.prompt} /> : <p className="lem-waiting">Loading…</p>}
      <figcaption>
        <p className="image-prompt">{record.prompt}</p>
        <p className="dim">
          {[
            when(record.at),
            record.size,
            record.preset ? presetById(record.preset)?.label : undefined,
            record.seconds ? `${record.seconds}s` : undefined,
            record.external ? "made off this machine" : undefined,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <div className="image-actions">
          <button type="button" onClick={() => onReuse(record)}>Use this prompt again</button>
          <button type="button" onClick={() => void window.myra.imageSaveCopy(record.id)}>
            Save a copy…
          </button>
          <button type="button" onClick={() => void window.myra.imageReveal(record.id)}>
            Show in folder
          </button>
          <span className="composer-spacer" />
          {confirming ? (
            <>
              <span className="dim">Delete this image?</span>
              <button type="button" className="danger" onClick={onDelete}>Delete</button>
              <button type="button" onClick={() => setConfirming(false)}>Cancel</button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirming(true)}>Delete</button>
          )}
        </div>
      </figcaption>
    </figure>
  );
}

function Thumb({ record }: { record: ImageRecord }) {
  const url = useBytes(record);
  return url ? <img src={url} alt="" loading="lazy" /> : <span className="image-tile-blank" />;
}

/**
 * The bytes for one image, fetched once and remembered.
 *
 * Over IPC rather than by path: the window is sandboxed and has no filesystem,
 * and its content policy allows no request off the page anyway. The cache is
 * what stops a gallery of forty pictures re-reading every one of them each time
 * the grid re-renders.
 */
function useBytes(record: ImageRecord): string | undefined {
  const [url, setUrl] = useState<string | undefined>(() => urls.get(record.id));

  useEffect(() => {
    const cached = urls.get(record.id);
    if (cached) {
      setUrl(cached);
      return;
    }
    let live = true;
    void window.myra.imageRead(record.id).then((r) => {
      if (!live || !r.ok || !r.image) return;
      setUrl(urlFor(record.id, r.image, r.mime ?? record.mime));
    });
    return () => {
      live = false;
    };
  }, [record.id, record.mime]);

  return url;
}
