import { useEffect, useState } from "react";
import type { DownloadProgress, Settings, WhisperSnapshot } from "../types.ts";

/**
 * Setting up transcription, which needs its own runtime.
 *
 * The obvious question is why this is not the llama.cpp runtime already
 * installed, and the answer is in llama-server's own strings: its
 * `/v1/audio/transcriptions` is a shim that converts the request into a chat
 * completion against an audio-capable model, and it supports `json` only. A
 * meeting is two tracks interleaved by time, so it needs the segment timestamps
 * that only `verbose_json` carries. whisper.cpp returns them.
 *
 * The shape of this screen follows from that: one small binary, one model, and
 * a plain statement of what each model costs. No quantisation table, no fit
 * arithmetic — a Whisper model is hundreds of megabytes and either downloaded
 * or not.
 */

function mb(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}

export function WhisperSetup({
  snapshot,
  settings,
}: {
  snapshot: WhisperSnapshot | undefined;
  settings: Settings;
}) {
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [progress, setProgress] = useState<DownloadProgress | undefined>();

  useEffect(() => window.karen.onWhisperDownload(setProgress), []);

  if (!snapshot) return <p className="dim">Checking…</p>;

  const { config, server, installed, unavailable, catalogue } = snapshot;
  const endpoint = settings.transcription.baseUrl.trim();

  const run = async (what: string, fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    setBusy(what);
    setError(undefined);
    const result = await fn();
    setBusy(undefined);
    setProgress(undefined);
    if (!result.ok) setError(result.error);
  };

  return (
    <div className="whisper">
      <section className="whisper-block">
        <h2>Transcription runtime</h2>
        {unavailable ? (
          /* Said plainly rather than hidden. whisper.cpp publishes an
             xcframework for Apple and no command-line build, so there is
             genuinely nothing to download on a Mac. */
          <p className="meeting-warning">{unavailable}</p>
        ) : config.binary ? (
          <p className="dim">
            whisper.cpp <strong>{config.tag}</strong> is installed.{" "}
            {server.state === "ready" ? "Running." : "It starts when a transcription is asked for."}
          </p>
        ) : (
          <>
            <p className="dim">
              A small program that turns audio into text on this machine — about 9 MB. It is
              separate from the model runtime because llama.cpp cannot produce the timestamps a
              two-track recording is assembled from.
            </p>
            <button
              type="button"
              className="primary-sm"
              disabled={Boolean(busy)}
              onClick={() => void run("runtime", () => window.karen.whisperInstall())}
            >
              {busy === "runtime" ? "Installing…" : "Install it"}
            </button>
          </>
        )}
      </section>

      {progress ? (
        <div className="hub-progress">
          <div className="bar">
            <span
              style={{
                width: progress.totalBytes
                  ? `${Math.round((progress.receivedBytes / progress.totalBytes) * 100)}%`
                  : "100%",
              }}
            />
          </div>
          <span className="dim">
            {progress.what} — {mb(progress.receivedBytes)}
            {progress.totalBytes ? ` of ${mb(progress.totalBytes)}` : ""}
          </span>
          <button type="button" onClick={() => void window.karen.whisperCancel()}>
            Cancel
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="hub-alert error" role="alert">
          {error}
        </p>
      ) : null}

      {!unavailable ? (
        <section className="whisper-block">
          <h2>Model</h2>
          <p className="dim">
            Bigger is more accurate and slower. Any of these runs on a processor; on a long
            meeting the difference is minutes.
          </p>
          <ul className="whisper-models">
            {catalogue.map((m) => {
              const here = installed.includes(m.file);
              const active = config.modelFile === m.file;
              return (
                <li key={m.file} className={active ? "whisper-model active" : "whisper-model"}>
                  <div className="whisper-model-body">
                    <strong>{m.label}</strong>
                    <span className="pill">{mb(m.bytes)}</span>
                    {m.multilingual ? <span className="pill">any language</span> : null}
                    {active ? <span className="pill on">in use</span> : null}
                    <p className="dim">{m.hint}</p>
                  </div>
                  <div className="whisper-model-actions">
                    {here ? (
                      <>
                        {!active ? (
                          <button
                            type="button"
                            disabled={Boolean(busy)}
                            onClick={() => void run(m.file, () => window.karen.whisperModelUse(m.file))}
                          >
                            Use
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={Boolean(busy)}
                          onClick={() => void run(m.file, () => window.karen.whisperModelRemove(m.file))}
                        >
                          Delete
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={Boolean(busy) || !config.binary}
                        title={config.binary ? "" : "Install the runtime first."}
                        onClick={() => void run(m.file, () => window.karen.whisperModelInstall(m.file))}
                      >
                        {busy === m.file ? "Downloading…" : "Download"}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className="whisper-block">
        <h2>Where audio goes</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={config.useForTranscription}
            onChange={(e) =>
              void window.karen
                .whisperConfig({ useForTranscription: e.target.checked })
                .then(() => window.karen.whisperState().then(() => undefined))
            }
          />
          Transcribe on this machine when a model is downloaded
        </label>
        <p className="dim">
          {config.useForTranscription && config.modelFile
            ? "Recordings never leave this computer."
            : endpoint
              ? `Recordings are sent to ${endpoint}, which is where you pointed the transcription endpoint in Settings.`
              : "Nothing is set up, so a recording cannot be written up yet."}
        </p>
      </section>

      {server.state === "failed" && server.error ? (
        <section className="whisper-block">
          <p className="hub-alert error" role="alert">
            {server.error}
          </p>
          {server.log.length ? (
            <pre className="whisper-log">{server.log.slice(-12).join("\n")}</pre>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
