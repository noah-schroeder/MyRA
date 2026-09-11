/**
 * Turning a dropped file's bytes into text.
 *
 * Shared by peer review's manuscript and the chat composer's document drop --
 * moved out of review.ts so the chat feature does not depend on the review
 * module to read a file. Nothing about the behaviour changed in the move.
 *
 * The file arrives as BYTES, not as a path. `File.path` was removed in
 * Electron 32 and this app is on 43, so the obvious route -- take the dropped
 * file's path and open it -- needs `webUtils.getPathForFile` in the preload and
 * hands the main process an arbitrary absolute path to read, which is a hole in
 * the workspace jail for the sake of a convenience. None of that is needed: the
 * renderer can read a dropped `File` with `arrayBuffer()`, a standard web API,
 * and `pdfToText` already extracts from a `Uint8Array`.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import { pdfToText } from "../core/research/pdf.ts";
import { engines, readAsText } from "../core/documents/office.ts";
import { OWNER_ONLY_FILE } from "../core/paths.ts";
import { titleFromFileName, titleOf, wordCount } from "../core/review/manuscript.ts";

/** What extracting a file produced, or why it could not. */
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
 * arrangement of the page, and on a two-column document that means reading
 * across both columns -- every line the end of one sentence followed by the
 * middle of an unrelated one. `pdfToText` omits the flag, recovers reading order,
 * and dehyphenates. It also names a scanned PDF as such instead of returning
 * nothing.
 */
export async function extractDocument(name: string, bytes: Uint8Array): Promise<Extracted> {
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
       lists: this is somebody's own file, dropped in for one question, not a
       document Karen keeps. */
    const dir = await mkdtemp(join(tmpdir(), "karen-doc-"));
    const src = join(dir, `document${ext}`);
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
