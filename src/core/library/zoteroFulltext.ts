/**
 * Where a Zotero item's PDF is, and whether MyRA may read it.
 *
 * The pure half of reading a library's full texts: the SQL that lists an
 * item's attachments, and the rule that turns one attachment row into a path
 * -- or into a refusal. [main/runtime/zoteroFulltext.ts] runs the SQL on the
 * read-only snapshot and touches the disk.
 *
 * Zotero's `linkMode` decides everything (RESEARCH-REWORK.md's D2 table):
 *
 *   0 imported_file, 1 imported_url -- the file is in Zotero's own storage,
 *     `storage/<attachment key>/<name>`, and is read through `resolveInJail`
 *     against `<data dir>/storage`, like any other file the agent touches.
 *   2 linked_file -- anywhere on disk, often a synced "Zotero Attachments"
 *     folder. Read too, but on an ALLOWLIST rather than a jail: the only
 *     paths that can be opened are the ones Zotero's own database lists for
 *     an item in the scope the turn is allowed, the model names an item key
 *     and never a path, and only a regular `.pdf` is ever opened, read-only.
 *     That is the decision D2 asked to be made explicitly, and it was.
 *   3 linked_url -- not a file. Never read.
 *
 * Standalone PDFs -- an attachment filed straight into a collection with no
 * parent item -- are not listed: they have no title, authors or year of their
 * own for a citation to name, and the searches here exclude them already.
 */

export const IMPORTED_FILE = 0;
export const IMPORTED_URL = 1;
export const LINKED_FILE = 2;
export const LINKED_URL = 3;

/** Zotero's own name for the text it extracted, beside each attachment in storage. */
export const FT_CACHE = ".zotero-ft-cache";

/** The personal library, as zoteroDb.ts scopes every other query. */
const USER_LIBRARY = "(SELECT libraryID FROM libraries WHERE type = 'user' ORDER BY libraryID LIMIT 1)";

/**
 * The PDF attachments of these parent items, by the parents' keys.
 *
 * Not-trashed on both sides: a PDF moved to the trash is gone as far as the
 * person is concerned, even though its row and its file are still there.
 */
export function attachmentsSql(parentKeys: readonly string[]): string {
  const marks = parentKeys.map(() => "?").join(", ");
  return `
    SELECT p.key AS parentKey, i.key AS key, a.linkMode AS linkMode,
           a.contentType AS contentType, a.path AS path
    FROM itemAttachments a
    JOIN items i ON i.itemID = a.itemID
    JOIN items p ON p.itemID = a.parentItemID
    WHERE p.key IN (${marks})
      AND i.libraryID = ${USER_LIBRARY}
      AND a.itemID NOT IN (SELECT itemID FROM deletedItems)
      AND a.parentItemID NOT IN (SELECT itemID FROM deletedItems)
    ORDER BY p.key, i.dateAdded
  `;
}

export interface AttachmentRow {
  parentKey: string;
  key: string;
  linkMode: number;
  contentType: string;
  path: string;
}

/** Where one attachment's file is, as far as the database says -- nothing here has looked at the disk. */
export type AttachmentLocation =
  | { kind: "storage"; key: string; parentKey: string; relative: string }
  | { kind: "linked"; key: string; parentKey: string; absolute: string }
  | { kind: "unreadable"; key: string; parentKey: string; why: string };

const ITEM_KEY = /^[A-Z0-9]{8}$/;

export function isItemKey(key: string): boolean {
  return ITEM_KEY.test(key);
}

function isPdf(row: AttachmentRow): boolean {
  return row.contentType === "application/pdf" || /\.pdf$/i.test(row.path);
}

/**
 * One row, located.
 *
 * `baseDir` is the Linked Attachment Base Directory from Zotero's prefs, which
 * `attachments:` paths are relative to. A relative path with no base set, or
 * any path that is not absolute once resolved, is unreadable rather than
 * guessed at -- resolving it against MyRA's own working directory would open
 * whatever happened to be there.
 */
export function locate(row: AttachmentRow, baseDir: string | undefined): AttachmentLocation {
  const { key, parentKey } = row;
  const no = (why: string): AttachmentLocation => ({ kind: "unreadable", key, parentKey, why });
  if (!isItemKey(key) || !isItemKey(parentKey)) return no("its Zotero key is not one");
  if (!isPdf(row)) return no("it is not a PDF");

  if (row.linkMode === IMPORTED_FILE || row.linkMode === IMPORTED_URL) {
    const name = row.path.startsWith("storage:") ? row.path.slice("storage:".length) : "";
    if (!name) return no("Zotero has no file name recorded for it");
    return { kind: "storage", key, parentKey, relative: `${key}/${name}` };
  }

  if (row.linkMode === LINKED_FILE) {
    let absolute = row.path;
    if (absolute.startsWith("attachments:")) {
      if (!baseDir) return no("it is linked relative to a base folder Zotero's settings no longer name");
      absolute = joinPosixOrWin(baseDir, absolute.slice("attachments:".length));
    }
    if (!isAbsolute(absolute)) return no("its linked path is not an absolute one");
    if (absolute.includes("\0")) return no("its linked path is not a usable one");
    return { kind: "linked", key, parentKey, absolute };
  }

  if (row.linkMode === LINKED_URL) return no("it is a link to a web page, not a file");
  return no("Zotero stores it in a way MyRA does not read");
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** Zotero writes `attachments:` paths with forward slashes on every platform. */
function joinPosixOrWin(base: string, rest: string): string {
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  const cleanRest = rest.replace(/^[\\/]+/, "").replace(/[\\/]/g, sep);
  return `${base.replace(/[\\/]+$/, "")}${sep}${cleanRest}`;
}

/**
 * The one PDF to read for an item, when it has several: the first stored in
 * Zotero's own storage, else the first linked file. A supplementary file
 * attached after the paper does not win because it was added last.
 */
export function primaryAttachment(located: readonly AttachmentLocation[]): AttachmentLocation | undefined {
  return (
    located.find((l) => l.kind === "storage") ??
    located.find((l) => l.kind === "linked") ??
    located[0]
  );
}
