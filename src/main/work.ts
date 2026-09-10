/**
 * The long job that is not a chat turn, held where it outlives a screen.
 *
 * A peer review panel and a paper section are both minutes of work started from
 * a page the window unmounts as soon as you look at something else. Until this
 * existed, each kept its own `AbortController` and streamed deltas straight at
 * the renderer, so leaving the tab meant the deltas arrived at nobody, the
 * finished text landed in an unmounted component, and the guard stayed held --
 * the next attempt was refused by a run whose output had already been thrown
 * away. Downloads had the same disease and were cured the same way: move the
 * record to where the work is.
 *
 * Three decisions worth keeping.
 *
 * **The snapshot is absolute, not a delta.** One channel carrying the whole
 * current state, rather than an append-this frame. `runSubagent` retries a
 * failed request up to three times and an attempt that died halfway has already
 * streamed half a report, so both features carried a `reset` flag to tell the
 * page to start the paragraph again -- the same bug fixed twice, in two places,
 * either of which could be forgotten next time. With an absolute snapshot a
 * retry is `restart()`, and writing a report twice is not expressible.
 *
 * **A late subscriber gets everything.** `current()` behind an IPC handler is
 * what lets a page that mounts mid-run draw the reviewer already in progress.
 * `karen:research-active` is push-only and has no such handler, which is why a
 * research page opened during a long stage sits blank until the next stage
 * begins; this is deliberately not that.
 *
 * **One at a time, across both features.** Two long generations on one card is
 * the out-of-memory that meetings avoids by transcribing serially and images by
 * generating serially. A chat turn is deliberately NOT in this lease: it is
 * short, the user is waiting for it, and making them wait behind a twenty-minute
 * panel would be a worse app than one that occasionally queues inside the
 * server.
 *
 * No `electron` import, so the test runner can load it -- the reason
 * `projectStore.ts` is split from `projects.ts`.
 */

export type JobKind = "review" | "paper";

/** What the page draws, in full, every time. */
export interface JobSnapshot {
  kind: JobKind;
  /** The record on disk this is writing into. */
  id: string;
  title: string;
  /** 0-based, so `step + 1` of `steps` reads correctly while the first runs. */
  step: number;
  steps: number;
  /** What is being written right now: a reviewer's name, a section's heading. */
  label: string;
  /** Papers only: which section the text belongs to. */
  sectionId?: string | undefined;
  text: string;
  thinking: string;
  startedAt: string;
}

export interface JobInit {
  kind: JobKind;
  id: string;
  title: string;
  steps: number;
  label?: string;
  sectionId?: string | undefined;
}

/**
 * The channel the whole snapshot rides on, and `null` when nothing is running.
 *
 * One name for both features: the rail draws "something long is happening" the
 * same way whichever it is, and a second channel would be a second thing to
 * forget to unsubscribe.
 */
export const WORK_CHANNEL = "karen:work";

/**
 * How often the snapshot is pushed while text is arriving.
 *
 * `main/downloads.ts` settled on the same figure for the same reason: a token
 * arrives every few milliseconds and the window does not need to hear about
 * each one, but a second of silence in a stream reads as a stall.
 */
const PUBLISH_MS = 250;

/**
 * The most live text kept in memory for one step.
 *
 * A guard, not a policy. The record on disk is written from `runSubagent`'s
 * return value, so trimming here costs the page the top of a very long report
 * while it streams and costs the saved review nothing. A reviewer's report with
 * a PRISMA table is about 60 kB; anything past this is already pathological.
 */
const MAX_LIVE = 256 * 1024;

function tail(text: string): string {
  return text.length > MAX_LIVE ? text.slice(text.length - MAX_LIVE) : text;
}

export interface Jobs {
  /** The running job, for a page that has just mounted. */
  current(): JobSnapshot | undefined;
  /** Claim the lease. `undefined` means something else already holds it. */
  begin(init: JobInit): AbortSignal | undefined;
  /** Move to the next reviewer or section: new label, text starts again. */
  step(patch: { step?: number; label?: string; sectionId?: string | undefined }): void;
  append(kind: "text" | "thinking", text: string): void;
  /** A retry is about to re-send: throw away the half that arrived. */
  restart(): void;
  end(): void;
  /** Stop the running job, or only the named one if it is still that one. */
  cancel(id?: string): void;
}

export function createJobs(send: (channel: string, payload?: unknown) => void): Jobs {
  let job: JobSnapshot | undefined;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const publish = (now: boolean): void => {
    if (now) {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      send(WORK_CHANNEL, job ?? null);
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      send(WORK_CHANNEL, job ?? null);
    }, PUBLISH_MS);
  };

  return {
    current: () => job,

    begin(init) {
      if (job) return undefined;
      controller = new AbortController();
      job = {
        kind: init.kind,
        id: init.id,
        title: init.title,
        step: 0,
        steps: init.steps,
        label: init.label ?? "",
        ...(init.sectionId ? { sectionId: init.sectionId } : {}),
        text: "",
        thinking: "",
        startedAt: new Date().toISOString(),
      };
      publish(true);
      return controller.signal;
    },

    step(patch) {
      if (!job) return;
      job = {
        ...job,
        ...(patch.step !== undefined ? { step: patch.step } : {}),
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.sectionId !== undefined ? { sectionId: patch.sectionId } : {}),
        text: "",
        thinking: "",
      };
      /* At once: this is the line that says which reviewer is being written, and
         a reviewer who takes four minutes is four minutes of nothing else. */
      publish(true);
    },

    append(kind, text) {
      if (!job || !text) return;
      job =
        kind === "thinking"
          ? { ...job, thinking: tail(job.thinking + text) }
          : { ...job, text: tail(job.text + text) };
      publish(false);
    },

    restart() {
      if (!job) return;
      job = { ...job, text: "", thinking: "" };
      publish(true);
    },

    end() {
      job = undefined;
      controller = undefined;
      publish(true);
    },

    cancel(id) {
      /* The id makes a stale Stop button harmless: a page that was showing the
         previous job must not abort the one that replaced it. */
      if (id && job && job.id !== id) return;
      controller?.abort();
    },
  };
}
