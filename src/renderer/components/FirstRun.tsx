import { useCallback, useEffect, useState } from "react";
import type { DownloadProgress, RuntimeState } from "../types.ts";

/**
 * The first launch.
 *
 * Karen needs two things it cannot ship inside the application bundle: pandoc,
 * to write Word and OpenDocument files, and Lemonade to run a model.
 * Before this screen existed neither was mentioned anywhere — the runtime was
 * reachable only by opening Settings and finding a pane, and pandoc was not
 * reachable at all, so "write this as a .docx" failed with an error about a
 * program the user had never been asked to install.
 *
 * The two are treated differently on purpose. pandoc is 34 MB, has no options
 * and is needed by a feature on the front page, so it installs itself and
 * reports what it did. A runtime build is several hundred megabytes and its
 * choice depends on the graphics card, so it is offered, with the machine's own
 * hardware named in the offer, and never started without a press.
 *
 * Skipping is a real option and says what it costs. An install nobody can
 * decline is not consent, and someone on a hotel connection has every right to
 * do this later.
 */

function mb(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

type Phase = "idle" | "working" | "done" | "failed";

export function FirstRun({ onDone }: { onDone: () => void }) {
  const [pandoc, setPandoc] = useState<Phase>("idle");
  const [pandocNote, setPandocNote] = useState<string | undefined>();
  const [runtime, setRuntime] = useState<Phase>("idle");
  const [runtimeNote, setRuntimeNote] = useState<string | undefined>();
  const [state, setState] = useState<RuntimeState | undefined>();
  const [progress, setProgress] = useState<DownloadProgress | undefined>();

  const installPandoc = useCallback(async () => {
    setPandoc("working");
    setPandocNote(undefined);
    const result = await window.karen.installPandoc();
    if (result.ok) {
      setPandoc("done");
      setPandocNote(`pandoc ${result.version ?? ""} installed.`.trim());
    } else {
      setPandoc("failed");
      setPandocNote(result.error);
    }
  }, []);

  useEffect(() => {
    const offSetup = window.karen.onSetupProgress(setProgress);
    const offRuntime = window.karen.onRuntimeDownload((p) => setProgress(p as DownloadProgress));
    const offState = window.karen.onRuntime((s) => setState(s as RuntimeState));
    void window.karen.runtimeState().then((s) => setState(s as RuntimeState));

    // pandoc starts on its own: it is small, has nothing to choose, and the
    // first thing a new user is likely to ask for is a document.
    void window.karen.engines().then((e) => {
      if (e.pandoc) {
        setPandoc("done");
        setPandocNote(`Already present${e.pandocVersion ? ` — ${e.pandocVersion}` : ""}.`);
      } else {
        void installPandoc();
      }
    });

    return () => {
      offSetup();
      offRuntime();
      offState();
    };
  }, [installPandoc]);

  const installRuntime = async (): Promise<void> => {
    setRuntime("working");
    setRuntimeNote(undefined);
    const result = await window.karen.lemonadeEnsure();
    if (result.ok) {
      setRuntime("done");
      setRuntimeNote(undefined);
    } else {
      setRuntime("failed");
      setRuntimeNote(result.error);
    }
  };

  /* Lemonade is either running or it is not; which engine and which card it
     chose is its business and is shown in Settings rather than here. */
  const ready = state?.lemonade.state === "ready";
  const busy = pandoc === "working" || runtime === "working";

  return (
    <div className="firstrun-backdrop">
      <section className="firstrun" aria-label="Set up Karen">
        <header>
          <h1>Welcome to Karen</h1>
          <p>
            Everything Karen does happens on this machine. Two pieces are downloaded rather
            than bundled, because they are large and specific to your hardware.
          </p>
        </header>

        <ul className="firstrun-steps">
          <Step
            title="Document tools"
            what="pandoc, so Karen can write Word, OpenDocument and HTML files."
            phase={pandoc}
            note={pandocNote}
            action={pandoc === "failed" ? { label: "Try again", run: () => void installPandoc() } : undefined}
          />
          <Step
            title="Model runtime"
            what={
              ready
                ? "The local engine is installed and running."
                : true
                  ? "Lemonade, which downloads the right engine for your hardware."
                  : "llama.cpp, to run a model on this machine. A few hundred megabytes."
            }
            phase={ready ? "done" : runtime}
            note={runtimeNote}
            action={
              ready || runtime === "working"
                ? undefined
                : { label: runtime === "failed" ? "Try again" : "Install", run: () => void installRuntime() }
            }
          />
        </ul>

        {progress ? (
          <div className="firstrun-progress">
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
          </div>
        ) : null}

        <footer className="firstrun-foot">
          <p className="dim">
            You can do any of this later from Settings. Nothing is sent anywhere: these are
            downloads from GitHub and nothing else leaves your machine.
          </p>
          <button type="button" className="primary" onClick={onDone} disabled={busy}>
            {busy ? "Working…" : ready ? "Start using Karen" : "Continue without a local engine"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function Step({
  title,
  what,
  phase,
  note,
  action,
}: {
  title: string;
  what: string;
  phase: Phase;
  note?: string | undefined;
  action?: { label: string; run: () => void } | undefined;
}) {
  return (
    <li className={`firstrun-step ${phase}`}>
      <span className="firstrun-mark" aria-hidden="true">
        {phase === "done" ? "✓" : phase === "failed" ? "!" : phase === "working" ? "…" : "•"}
      </span>
      <div className="firstrun-body">
        <h2>{title}</h2>
        <p>{what}</p>
        {note ? <p className={phase === "failed" ? "firstrun-error" : "dim"}>{note}</p> : null}
      </div>
      {action ? (
        <button type="button" onClick={action.run}>
          {action.label}
        </button>
      ) : null}
    </li>
  );
}
