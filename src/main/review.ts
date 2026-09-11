/**
 * Reading somebody else's manuscript, and reviewing it.
 *
 * The file arrives as BYTES, not as a path, and that is the whole reason this
 * was cheap to build. `File.path` was removed in Electron 32 and this app is on
 * 43, so the obvious route -- take the dropped file's path and open it -- needs
 * `webUtils.getPathForFile` in the preload and then hands the main process an
 * arbitrary absolute path to read, which is a hole in the workspace jail for
 * the sake of a convenience.
 *
 * None of that is needed, because the renderer can read a dropped `File` with
 * `arrayBuffer()` -- a standard web API, not filesystem access, so the sandbox
 * is untouched -- and `pdfToText` in core/research/pdf.ts already extracts from
 * a `Uint8Array`. Binary already crosses this bridge for meeting and dictation
 * audio. So Karen never learns where the manuscript lives, which is also the
 * right answer for a confidential file under review.
 */

import { dialog, ipcMain } from "electron";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ConfigStore } from "../core/config.ts";
import type { EndpointSettings } from "../core/config.ts";
import { runSubagent } from "../core/llm/chat.ts";
import { citationsIn } from "../core/documents/draft.ts";
import { makeOwnDir, OWNER_ONLY_FILE } from "../core/paths.ts";
import { fitsContext, tooLongMessage, wordCount } from "../core/review/manuscript.ts";
import { extractDocument, type Extracted } from "./extract.ts";
import {
  assembleReview, buildSystem, buildUser, type ReviewRequest,
} from "../core/review/prompt.ts";
import {
  assertReviewId, byNewest, newReview, summaryOf,
  type Review, type ReviewSummary,
} from "../core/review/record.ts";
import { idOfFile, parseRecord, reviewFileName } from "../core/review/store.ts";
import type { Jobs } from "./work.ts";

export interface ReviewDeps {
  config: ConfigStore;
  /**
   * The model that is actually answering, resolved the way chat resolves it.
   *
   * Not `settings.llm`: with a local model loaded that field is empty, and
   * reading it directly is how meetings came to report "no LLM endpoint is
   * configured" while a model sat loaded.
   */
  llm: () => Promise<{ endpoint: EndpointSettings; apiKey?: string; label?: string }>;
  /**
   * The loaded model's context window, when there is one.
   *
   * Read from the runtime rather than from the resolver, which is where the
   * conversation's own context meter reads it: it is `ctx_size` as the daemon
   * actually loaded the model, and a hosted provider does not report one at
   * all. Undefined means "not measurable", never "zero".
   */
  contextTokens: () => number | undefined;
  send: (channel: string, payload?: unknown) => void;
  /**
   * The lease on long work, shared with the paper drafter.
   *
   * Injected rather than owned, because "one long generation at a time" is a
   * fact about the graphics card and not about peer review.
   */
  jobs: Jobs;
  /**
   * A review has just come into existence, and here is its id.
   *
   * Injected rather than imported, for the reason papers.ts gives: the module
   * that files it also reads reviews, so importing it here would be a cycle.
   */
  onCreated?: (ref: string) => void;
}

/* ------------------------------------------------------------------ *
 * The record on disk                                                  *
 * ------------------------------------------------------------------ */

function rootOf(deps: Pick<ReviewDeps, "config">): string {
  return deps.config.current.reviewsRoot;
}

async function readReview(root: string, id: string): Promise<Review | undefined> {
  try {
    const raw = await readFile(join(root, reviewFileName(assertReviewId(id))), "utf8");
    return parseRecord(JSON.parse(raw), id);
  } catch {
    /* Missing, unparseable, or half-written by a sync client. The list already
       skips what it cannot read; opening one directly says so instead. */
    return undefined;
  }
}

/**
 * Write the record, via a temporary name.
 *
 * The rename is what makes the save atomic, and this one is saved after every
 * reviewer rather than once at the end: a panel is three long requests, and a
 * crash during the third must leave the first two on disk rather than an hour
 * of nothing. It is the pipeline's rule -- a finished stage is its own
 * done-marker -- applied to a smaller pipeline.
 */
async function saveReview(root: string, review: Review): Promise<Review> {
  await makeOwnDir(root);
  const stored: Review = { ...review, updatedAt: new Date().toISOString() };
  const target = join(root, reviewFileName(assertReviewId(review.id)));
  const temp = `${target}.partial`;
  await writeFile(temp, JSON.stringify(stored, null, 2), { mode: OWNER_ONLY_FILE });
  await rename(temp, target);
  return stored;
}

export async function listReviews(root: string): Promise<ReviewSummary[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const out: ReviewSummary[] = [];
  for (const name of names) {
    const id = idOfFile(name);
    if (!id) continue;
    const review = await readReview(root, id);
    if (review) out.push(summaryOf(review));
  }
  return out.sort(byNewest);
}

/**
 * Read one review, or nothing if it cannot be read.
 *
 * Exported alongside the delete because a project needs both: it writes the
 * report into the export folder and removes it when the project goes.
 */
export async function readReviewRecord(root: string, id: string): Promise<Review | undefined> {
  return await readReview(root, id);
}

/** Remove one review. The same call the page's own Delete makes. */
export async function deleteReview(root: string, id: string): Promise<void> {
  await rm(join(root, reviewFileName(assertReviewId(id))), { force: true });
}

export function installReviewIpc(deps: ReviewDeps): void {
  const { send, jobs } = deps;

  /**
   * The list, with the review this process is actually writing shown as such.
   *
   * `parseRecord` reads a `running` status back as `stopped` on purpose -- see
   * its own comment -- because ordinarily nothing is left writing a record that
   * still says so after a crash. But this module saves after every reviewer
   * and republishes the list from the same disk read in the same breath, so
   * without this, "Your reviews" would call its own job abandoned the moment
   * the first reviewer finishes -- while the panel right below it is visibly
   * still writing the second.
   */
  const listLive = async (): Promise<ReviewSummary[]> => {
    const rows = await listReviews(rootOf(deps));
    const current = jobs.current();
    if (current?.kind !== "review") return rows;
    return rows.map((r) => (r.id === current.id ? { ...r, status: "running" as const } : r));
  };

  const publish = async (): Promise<void> => {
    send("karen:reviews", await listLive());
  };

  ipcMain.handle("karen:review-extract", async (_e, name: unknown, bytes: unknown) => {
    const buffer = bytes as ArrayBuffer | Uint8Array | undefined;
    if (!buffer) return { ok: false, error: "Nothing was dropped." } satisfies Extracted;
    const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    return extractDocument(String(name ?? "manuscript"), view);
  });

  /**
   * What the model can hold, so the page can refuse before it sends.
   *
   * Asked separately rather than folded into the review call, because the
   * answer decides whether the button is a button at all -- and it changes when
   * the user loads a different model, without the manuscript changing.
   *
   * A QUESTION, and it must not behave like a request. It used to resolve the
   * endpoint the way a real turn does, and resolving calls `ensureChatModel`,
   * which loads the chosen model back in when nothing is resident. The page
   * re-asks whenever the runtime changes, and a model going away IS a runtime
   * change -- so unloading the model while this page was open loaded it
   * straight back, about a second later, and the model it brought back was
   * then loaded everywhere else too. The card was never actually freed.
   *
   * The window is read off the runtime instead, which is where the
   * conversation's own context meter reads it, so the two cannot disagree
   * about whether a manuscript fits. Nothing here starts anything.
   */
  ipcMain.handle("karen:review-context", () => {
    const limit = deps.contextTokens();
    return { ok: true, ...(limit ? { contextTokens: limit } : {}) };
  });

  ipcMain.handle("karen:review-list", async () => {
    return { ok: true, reviews: await listLive() };
  });

  ipcMain.handle("karen:review-open", async (_e, id: unknown) => {
    const review = await readReview(rootOf(deps), String(id ?? ""));
    return review
      ? { ok: true, review }
      : { ok: false, error: "That review could not be read." };
  });

  ipcMain.handle("karen:review-delete", async (_e, id: unknown) => {
    try {
      await deleteReview(rootOf(deps), String(id ?? ""));
      await publish();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  /**
   * Save the review where the reviewer says.
   *
   * A save dialog as well as the record, because a review is not only Karen's
   * record -- it goes back to an editor, usually pasted into a submission
   * system, and the person knows where they keep this year's reviewing.
   */
  ipcMain.handle("karen:review-save", async (_e, name: unknown, text: unknown) => {
    try {
      const chosen = await dialog.showSaveDialog({
        title: "Save this review",
        defaultPath: String(name || "review.md"),
      });
      if (chosen.canceled || !chosen.filePath) return { ok: true, saved: false };
      await mkdir(dirname(chosen.filePath), { recursive: true }).catch(() => undefined);
      /* Not re-chmodded: a directory the user chose is theirs, which is the
         rule paths.ts states. */
      await writeFile(chosen.filePath, String(text ?? ""), "utf8");
      return { ok: true, saved: true, path: chosen.filePath };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("karen:review-cancel", async (_e, id: unknown) => {
    jobs.cancel(id ? String(id) : undefined);
    return { ok: true };
  });

  /**
   * Write the reviews: one request per reviewer on the panel.
   *
   * Not one request for all three. Three reports of up to 2,000 words each is
   * six thousand words of output, which on a local model is where quality
   * collapses and where the context ceiling is met from the wrong side. It is
   * also the more faithful arrangement -- three reviewers who have not read
   * each other is what a journal sends an editor.
   *
   * The requests are built by the page and sent whole, which is what makes the
   * preview honest: it renders these same two functions over the same objects,
   * so "exactly what will be sent" is the thing that is sent rather than a
   * reconstruction of it.
   *
   * The record is written before the first reviewer and again after every one,
   * and the page is not part of that path. Leaving the tab mid-panel used to
   * throw the finished report away: the run carried on writing into a component
   * the window had already unmounted.
   */
  ipcMain.handle("karen:review-run", async (_e, raw: unknown, meta: unknown) => {
    const requests = raw as ReviewRequest[];
    if (!Array.isArray(requests) || requests.length === 0) {
      return { ok: false, error: "Choose what kind of paper this is first." };
    }
    const first = requests[0];
    if (!first?.manuscript?.trim()) {
      return { ok: false, error: "There is no manuscript to review." };
    }
    const about = (meta ?? {}) as { title?: string; fileName?: string; studyTypeId?: string };
    const title = String(about.title ?? first.title ?? "");

    const root = rootOf(deps);
    let record = newReview({
      title,
      fileName: String(about.fileName ?? ""),
      /* Counted here, while the manuscript is in hand. It is the last moment
         anything can: the text is not written to the record, and the record is
         the only thing that outlives this call. */
      words: wordCount(first.manuscript),
      studyTypeId: String(about.studyTypeId ?? ""),
      studyLabel: first.studyLabel,
      prompt: first.prompt,
      note: first.note,
      reviewers: requests.length,
    });

    const signal = jobs.begin({
      kind: "review",
      id: record.id,
      title: record.title,
      steps: requests.length,
      label: first.reviewerLabel,
    });
    if (!signal) return { ok: false, error: "Karen is already working on something long." };

    const reports: { label: string; text: string }[] = [];
    try {
      const resolved = await deps.llm();
      /*
       * The fit, checked again here, because THIS is the first moment the
       * window is known.
       *
       * The page checks too, and that check is the one that greys the button
       * -- but it can only measure against a model that is already loaded, and
       * with nothing loaded there is no number to measure against until the
       * resolver above has loaded one. Without this, a manuscript dropped onto
       * a page with no model resident would be sent whole to a window it does
       * not fit, and come back as a review that is fluent about the
       * introduction and silent on the results. Refusing is the entire point
       * of measuring; the message is the same one the page shows.
       */
      const fit = fitsContext(requests, deps.contextTokens());
      if (!fit.fits) return { ok: false, error: tooLongMessage(fit) };

      /* Written before a single token is asked for, so the run has somewhere to
         land from its first moment, and filed at the same time: a project
         member with no file on disk is pruned by the next read, and filing at
         the end would lose the filing exactly when the app dies mid-run. */
      record = await saveReview(root, record);
      deps.onCreated?.(record.id);
      await publish();

      for (const [index, request] of requests.entries()) {
        jobs.step({ step: index, label: request.reviewerLabel });

        const result = await runSubagent({
          model: resolved.endpoint.model ?? "",
          endpoint: resolved.endpoint,
          ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
          system: buildSystem(request),
          prompt: buildUser(request),
          signal,
          onDelta: (text, kind) => jobs.append(kind, text),
          /* A retry has already streamed half a report into the page; without
             this the second attempt appends to the first and the reviewer
             watches their summary written twice. */
          onProgress: (note) => {
            if (note.startsWith("retrying")) jobs.restart();
          },
        });

        const text = result.text.trim();
        /* One silent reviewer does not lose the other two. The panel is filed
           as it stands, with that reviewer's failure recorded in its place --
           dropping the heading would leave a two-reviewer report with no sign
           that a third had been asked for. */
        const body =
          text ||
          "*(This reviewer returned nothing usable — only its own reasoning, or an empty " +
            "reply. Try again, or choose a different model on the Models page.)*";
        reports.push({ label: request.reviewerLabel, text: body });
        record = await saveReview(root, {
          ...record,
          reports: [...record.reports, { reviewerId: request.reviewerId, label: request.reviewerLabel, text: body }],
          assembled: assembleReview(record.title, reports),
        });
        await publish();
      }

      const assembled = assembleReview(record.title, reports);
      /*
       * Reported, never repaired.
       *
       * The house rules forbid citing outside literature because nothing here
       * has searched, so any reference is invented -- and a fabricated citation
       * in a review goes to an editor, under the reviewer's name, as a reason
       * to reject somebody's work. Removing the marker would leave the sentence
       * it supported reading as the reviewer's own established fact, which is
       * the more dangerous of the two states. The paper drafter made the same
       * call for the same reason.
       *
       * Not theoretical: a small model under test produced a References section
       * of empty numbered markers on its first run.
       */
      const invented = citationsIn(assembled);
      record = await saveReview(root, { ...record, assembled, invented, status: "done" });
      await publish();
      return { ok: true, id: record.id, text: assembled, invented };
    } catch (err) {
      const message = (err as Error).message || "The review failed.";
      const assembled = reports.length ? assembleReview(record.title, reports) : "";
      const stopped = signal.aborted;
      /* Stopped after two of three: what was written is kept, because the
         alternative is discarding twenty minutes of work as the price of
         changing your mind about the third. */
      record = await saveReview(root, {
        ...record,
        assembled,
        status: stopped ? "stopped" : "failed",
        ...(stopped ? {} : { error: message }),
      });
      await publish();
      if (stopped) {
        return reports.length
          ? { ok: true, id: record.id, text: assembled, stopped: true }
          : { ok: false, error: "Stopped." };
      }
      return { ok: false, error: message };
    } finally {
      jobs.end();
    }
  });
}
