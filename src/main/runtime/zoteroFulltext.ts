/**
 * Reading the PDF behind a Zotero item: the half that touches the disk.
 *
 * [core/library/zoteroFulltext.ts](../../core/library/zoteroFulltext.ts)
 * decides what an attachment row means; this opens it. Never writes to Zotero,
 * never opens the live database -- the rows come from the snapshot -- and
 * never opens a path a model chose: the model names an item key, the path is
 * what Zotero recorded for that item, and it is still checked here.
 *
 * Two ways to the text, and they are not the same thing:
 *
 *   - **pdftotext, per page**, for reading: "p. 7" is what a citation needs.
 *     Slow enough (a second on a long paper) that it runs only when a paper is
 *     actually opened, and the pages are cached under CONFIG_DIR/fulltext,
 *     keyed by the file's size and mtime so a replaced PDF is re-read.
 *   - **Zotero's own `.zotero-ft-cache`**, for searching: the text Zotero
 *     already extracted when it indexed the file, beside it in storage. Free
 *     to read, so a project's whole shelf is searchable at once -- but it has
 *     no page breaks, so a passage found only through it says so, and
 *     `read_paper` is the step that recovers the page.
 */

import { readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveInJail } from "../../core/agent/tools/documents.ts";
import { CONFIG_DIR, makeOwnDir, OWNER_ONLY_FILE } from "../../core/paths.ts";
import { MAX_PDF_BYTES, pdfToPages } from "../../core/research/pdf.ts";
import { fullTextOf, type FullText } from "../../core/sources/fulltext.ts";
import {
  FT_CACHE, isItemKey, locate, primaryAttachment, type AttachmentLocation,
} from "../../core/library/zoteroFulltext.ts";
import { attachmentRowsFromDb, zoteroBaseAttachmentDir } from "./zoteroSqlite.ts";

/** One item's PDF, as far as MyRA can see it: where, and whether it can be opened. */
export type Located = AttachmentLocation & { dataDir: string };

/** The PDF to read for each of these items, by item key. Items with no PDF at all are absent. */
export async function locatePdfs(parentKeys: readonly string[]): Promise<Map<string, Located>> {
  const keys = [...new Set(parentKeys.filter(isItemKey))];
  const out = new Map<string, Located>();
  if (!keys.length) return out;
  const { rows, dataDir } = await attachmentRowsFromDb(keys);
  const base = zoteroBaseAttachmentDir();
  const byParent = new Map<string, AttachmentLocation[]>();
  for (const row of rows) {
    const located = locate(row, base);
    const list = byParent.get(row.parentKey) ?? [];
    list.push(located);
    byParent.set(row.parentKey, list);
  }
  for (const [parent, list] of byParent) {
    const primary = primaryAttachment(list);
    if (primary) out.set(parent, { ...primary, dataDir });
  }
  return out;
}

function storageRoot(dataDir: string): string {
  return join(dataDir, "storage");
}

/**
 * The real file behind a location, or why not.
 *
 * Storage files go through `resolveInJail` like every other file the agent
 * reads. A linked file is on an allowlist instead -- see the core module's
 * header -- and what is checked here is that the path Zotero recorded ends,
 * after every symlink, at a regular `.pdf` of a size worth reading.
 */
export async function realPdf(loc: Located): Promise<{ path: string; stamp: string } | { error: string }> {
  if (loc.kind === "unreadable") return { error: loc.why };
  let path: string;
  try {
    path =
      loc.kind === "storage"
        ? await resolveInJail(storageRoot(loc.dataDir), loc.relative)
        : await realpath(loc.absolute);
  } catch (err) {
    return { error: `its file could not be found (${(err as Error).message})` };
  }
  if (!/\.pdf$/i.test(path)) return { error: "its file is not a PDF" };
  try {
    const info = await stat(path);
    if (!info.isFile()) return { error: "its file is not a regular file" };
    if (info.size > MAX_PDF_BYTES) return { error: `its PDF is over ${MAX_PDF_BYTES / 1024 / 1024} MB` };
    return { path, stamp: `${info.size}:${Math.floor(info.mtimeMs)}` };
  } catch (err) {
    return { error: `its file could not be read (${(err as Error).message})` };
  }
}

function cacheDir(): string {
  return join(CONFIG_DIR, "fulltext");
}

function cachePath(key: string): string {
  if (!isItemKey(key)) throw new Error(`not a Zotero key: ${key}`);
  return join(cacheDir(), `${key}.json`);
}

async function readCache(key: string, stamp: string): Promise<string[] | undefined> {
  try {
    const raw = JSON.parse(await readFile(cachePath(key), "utf8")) as { stamp?: unknown; pages?: unknown };
    if (raw.stamp !== stamp || !Array.isArray(raw.pages)) return undefined;
    return raw.pages.map((p) => (typeof p === "string" ? p : ""));
  } catch {
    return undefined;
  }
}

async function writeCache(key: string, stamp: string, pages: string[]): Promise<void> {
  try {
    await makeOwnDir(cacheDir());
    const target = cachePath(key);
    await writeFile(`${target}.partial`, `${JSON.stringify({ stamp, pages })}\n`, { mode: OWNER_ONLY_FILE });
    await rename(`${target}.partial`, target);
  } catch {
    /* A cache that cannot be written is a slower second read, nothing worse. */
  }
}

/**
 * Zotero's own extracted text, if it made one -- jailed like a storage file,
 * since that is where it lives. The stamp is the CACHE FILE's own size and
 * mtime, the same shape `realPdf` gives the PDF path: fingerprinting by the
 * text's character count alone missed a re-extraction that happened to land
 * on the same length, so a project's index kept serving superseded text with
 * nothing to detect the drift.
 */
async function zoteroIndexText(loc: Located): Promise<{ text: string; stamp: string } | undefined> {
  if (!isItemKey(loc.key)) return undefined;
  try {
    const path = await resolveInJail(storageRoot(loc.dataDir), `${loc.key}/${FT_CACHE}`);
    const [raw, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    const text = raw.trim();
    return text ? { text, stamp: `${info.size}:${Math.floor(info.mtimeMs)}` } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The paper's text for READING: pages when pdftotext can produce them, the
 * unpaged index text when it cannot, and why neither when neither.
 */
export async function readZoteroPdf(loc: Located): Promise<{ text: FullText } | { error: string }> {
  const file = await realPdf(loc);
  if ("path" in file) {
    const cached = await readCache(loc.key, file.stamp);
    if (cached) return { text: fullTextOf(cached, true) };
    try {
      const pages = await pdfToPages(new Uint8Array(await readFile(file.path)));
      await writeCache(loc.key, file.stamp, pages);
      return { text: fullTextOf(pages, true) };
    } catch (err) {
      const fallback = await zoteroIndexText(loc);
      if (fallback) return { text: fullTextOf([fallback.text], false) };
      return { error: (err as Error).message };
    }
  }
  const fallback = await zoteroIndexText(loc);
  return fallback ? { text: fullTextOf([fallback.text], false) } : { error: file.error };
}

/**
 * The paper's text for SEARCHING, without running pdftotext: the cached pages
 * if this file was read before, else Zotero's index text. `stamp` says which
 * text it was, so an index built from it knows when it is out of date.
 */
export async function indexZoteroPdf(loc: Located): Promise<{ text: FullText; stamp: string } | { error: string }> {
  const file = await realPdf(loc);
  if ("path" in file) {
    const cached = await readCache(loc.key, file.stamp);
    if (cached) return { text: fullTextOf(cached, true), stamp: `pages:${file.stamp}` };
  }
  const fallback = await zoteroIndexText(loc);
  if (fallback) return { text: fullTextOf([fallback.text], false), stamp: `index:${fallback.stamp}` };
  return {
    error:
      "error" in file
        ? file.error
        : "Zotero has not indexed its text yet — read_paper can still open it",
  };
}
