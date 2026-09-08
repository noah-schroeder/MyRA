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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";

import type { ConfigStore } from "../core/config.ts";
import type { EndpointSettings } from "../core/config.ts";
import { runSubagent } from "../core/llm/chat.ts";
import { citationsIn } from "../core/documents/draft.ts";
import { pdfToText } from "../core/research/pdf.ts";
import { engines, readAsText } from "../core/documents/office.ts";
import { OWNER_ONLY_FILE } from "../core/paths.ts";
import { titleFromFileName, titleOf, wordCount } from "../core/review/manuscript.ts";
import { buildSystem, buildUser, type ReviewRequest } from "../core/review/prompt.ts";

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
}

/** What extracting a manuscript produced, or why it could not. */
export interface Extracted {
  ok: boolean;
  error?: string;
  /** Set when the failure is a missing converter the app can install itself. */
  needsPandoc?: boolean;
  text?: string;
  title?: string;
  words?: number;
}

/** Formats worth offering. Anything pandoc reads works; these are the honest ones. */
const OFFICE = new Set([".docx", ".doc", ".odt", ".rtf", ".tex", ".md", ".markdown", ".txt", ".text"]);

export function extensionOfName(name: string): string {
  return extname(name).toLowerCase();
}

/**
 * Turn a dropped file's bytes into text.
 *
 * PDF goes through `pdfToText` rather than `readAsText`, and the difference is
 * not cosmetic: `readAsText` passes `-layout`, which preserves the physical
 * arrangement of the page, and on a two-column manuscript that means reading
 * across both columns -- every line the end of one sentence followed by the
 * middle of an unrelated one. `pdfToText` omits the flag, recovers reading order,
 * and dehyphenates. It also names a scanned PDF as such instead of returning
 * nothing.
 */
export async function extractManuscript(name: string, bytes: Uint8Array): Promise<Extracted> {
  const ext = extensionOfName(name);
  try {
    if (ext === ".pdf") {
      const text = await pdfToText(bytes);
      return finish(name, text);
    }

    if (!OFFICE.has(ext)) {
      return {
        ok: false,
        error: `Karen cannot read ${ext || "that kind of file"}. Send it a PDF, a Word file, ODT, RTF or plain text.`,
      };
    }

    /* Plain text needs no converter, and saying so matters: it is the fallback
       somebody reaches for when pandoc is missing. */
    if (ext === ".md" || ext === ".markdown" || ext === ".txt" || ext === ".text") {
      return finish(name, new TextDecoder().decode(bytes));
    }

    const tools = await engines();
    if (!tools.pandoc) {
      return {
        ok: false,
        needsPandoc: true,
        error:
          "Reading Word and ODT files needs pandoc, which is not installed yet. " +
          "Karen can install it for you — it is a single program, fetched once.",
      };
    }

    /* Written to a temp file because pandoc reads a path, then removed. Owner
       only, and under the system temp directory rather than anywhere Karen
       lists: this is an unpublished manuscript belonging to someone who did not
       choose to give it to us. */
    const dir = await mkdtemp(join(tmpdir(), "karen-ms-"));
    const src = join(dir, `manuscript${ext}`);
    try {
      await writeFile(src, bytes, { mode: OWNER_ONLY_FILE });
      return finish(name, await readAsText(src));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message || "That file could not be read." };
  }
}

function finish(name: string, raw: string): Extracted {
  const text = raw.trim();
  if (!text) {
    return { ok: false, error: "That file has no text in it that Karen could read." };
  }
  return {
    ok: true,
    text,
    /* The document's own title where there is one, the filename where there is
       not. Both land in an editable box, so a wrong guess costs a moment. */
    title: titleOf(text) || titleFromFileName(name),
    words: wordCount(text),
  };
}

export function installReviewIpc(deps: ReviewDeps): void {
  const { send } = deps;
  let running: AbortController | undefined;

  ipcMain.handle("karen:review-extract", async (_e, name: unknown, bytes: unknown) => {
    const buffer = bytes as ArrayBuffer | Uint8Array | undefined;
    if (!buffer) return { ok: false, error: "Nothing was dropped." } satisfies Extracted;
    const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    return extractManuscript(String(name ?? "manuscript"), view);
  });

  /**
   * What the model can hold, so the page can refuse before it sends.
   *
   * Asked separately rather than folded into the review call, because the
   * answer decides whether the button is a button at all -- and it changes when
   * the user loads a different model, without the manuscript changing.
   */
  ipcMain.handle("karen:review-context", async () => {
    try {
      const resolved = await deps.llm();
      const limit = deps.contextTokens();
      return {
        ok: true,
        ...(limit ? { contextTokens: limit } : {}),
        label: resolved.label ?? "",
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  /**
   * Save the review where the reviewer says.
   *
   * A save dialog rather than a folder Karen owns, because a review is not
   * Karen's record -- it goes back to an editor, usually pasted into a
   * submission system, and the person knows where they keep this year's
   * reviewing. Nothing is kept here afterwards.
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

  ipcMain.handle("karen:review-cancel", async () => {
    running?.abort();
    return { ok: true };
  });

  /**
   * Write the review.
   *
   * The request is built by the page and sent whole, which is what makes the
   * preview honest: it renders these same two functions over the same object,
   * so "exactly what will be sent" is the thing that is sent rather than a
   * reconstruction of it.
   */
  ipcMain.handle("karen:review-run", async (_e, raw: unknown) => {
    if (running) return { ok: false, error: "Karen is already writing a review." };
    const request = raw as ReviewRequest;
    if (!request || typeof request !== "object" || !request.manuscript?.trim()) {
      return { ok: false, error: "There is no manuscript to review." };
    }

    const controller = new AbortController();
    running = controller;
    try {
      const resolved = await deps.llm();
      const result = await runSubagent({
        model: resolved.endpoint.model ?? "",
        endpoint: resolved.endpoint,
        ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
        system: buildSystem(request),
        prompt: buildUser(request),
        signal: controller.signal,
        onDelta: (text, kind) => send("karen:review-delta", { kind, text }),
        onProgress: (note) => {
          /* A retry has already streamed half a review into the page. Without
             this the second attempt appends to the first and the reviewer
             watches their summary written twice -- the same failure the paper
             drafter hit, and the same fix. */
          if (note.startsWith("retrying")) {
            send("karen:review-delta", { kind: "text", text: "", reset: true });
          }
        },
      });
      const text = result.text.trim();
      if (!text) {
        return {
          ok: false,
          error:
            "The model returned nothing usable — only its own reasoning, or an empty reply. " +
            "Try again, or choose a different model on the Models page.",
        };
      }
      /*
       * Reported, never repaired.
       *
       * The prompt forbids citing literature because nothing in this flow has
       * searched, so any reference here is invented -- and a fabricated
       * citation inside a review goes to an editor, under the reviewer's name,
       * as a reason to reject somebody's work. Removing the marker would leave
       * the sentence it supported reading as the reviewer's own established
       * fact, which is the more dangerous of the two states. The paper drafter
       * made the same call for the same reason.
       *
       * Not theoretical: a small model under test produced a References
       * section of empty numbered markers on its first run.
       */
      return { ok: true, text, invented: citationsIn(text) };
    } catch (err) {
      const message = (err as Error).message || "The review failed.";
      return { ok: false, error: controller.signal.aborted ? "Stopped." : message };
    } finally {
      running = undefined;
    }
  });
}
