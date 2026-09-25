/**
 * Reading a Zotero library from its own database file.
 *
 * The local HTTP API is the right way in and is not always a way in at all.
 * Zotero installed as a Flatpak or a Snap runs inside a sandbox with its own
 * network namespace: the port is open, Zotero's own settings pane truthfully
 * says so, and nothing on the host can reach it whatever address is dialled.
 * That is not a bug MyRA can fix from the outside, and "install Zotero
 * differently" is not an answer to give a researcher whose library works.
 *
 * So when nothing answers on the port, MyRA reads `zotero.sqlite` instead. The
 * file is right there on the host filesystem -- a Flatpak's data directory is
 * under ~/.var/app, not inside the sandbox -- and Zotero's schema is published
 * and stable.
 *
 * This module is the pure half: the SQL, the shaping, and where to look. It
 * touches no filesystem, so it can be tested against a database built to
 * Zotero's own schema without an install of Zotero anywhere near it.
 *
 * TWO RULES, both about not damaging somebody's irreplaceable library:
 *
 *   1. Never write. Every statement here is a SELECT, and the connection is
 *      opened read-only on a snapshot rather than on the file itself.
 *   2. Never open the live file. Zotero holds it in WAL mode while running,
 *      and a live database is exactly the one you must not open read-write by
 *      accident. The snapshot is taken with SQLite's own backup API, which
 *      restarts if the source is written underneath it.
 *
 * The second rule is not theoretical: the same problem, solved the obvious way
 * with a file copy, produces torn pages under the ordinary case of Zotero
 * syncing while you search.
 */

import { formatCreators, yearOf, type LibraryItem, type SearchMode } from "./zotero.ts";

export const ZOTERO_DB = "zotero.sqlite";

/**
 * Where Zotero keeps its data directory, in the order worth trying.
 *
 * Zotero's own default is ~/Zotero on every platform, so that comes first. The
 * two sandboxed installs put it elsewhere, and those are precisely the installs
 * whose HTTP port cannot be reached -- so a list that omitted them would fail
 * exactly where the fallback is needed.
 *
 * A candidate is only a candidate: the caller checks that zotero.sqlite is
 * actually in it, because a folder someone happens to have named "Zotero" is
 * not a library.
 */
export function dataDirCandidates(home: string): string[] {
  const join = (...parts: string[]): string => parts.join("/");
  return [
    join(home, "Zotero"),
    /* Flatpak. Which of these it is depends on whether the app was granted
       access to the real home: with it, Zotero's default ~/Zotero is the real
       one above; without it, $HOME inside the sandbox is the per-app directory
       and "~/Zotero" lands under it. Both are on the ordinary filesystem --
       only the network namespace is sealed, which is the whole reason this
       route exists. */
    join(home, ".var", "app", "org.zotero.Zotero", "Zotero"),
    join(home, ".var", "app", "org.zotero.Zotero", "data", "Zotero"),
    // Snap, which uses its own package name and its own layout.
    join(home, "snap", "zotero-snap", "common", "Zotero"),
    join(home, "snap", "zotero-snap", "current", "Zotero"),
    join(home, "snap", "zotero", "common", "Zotero"),
    join(home, "snap", "zotero", "current", "Zotero"),
  ];
}

/**
 * Where to go looking when none of the fixed candidates has a library.
 *
 * A sandbox is free to lay its home out however it likes, and a guess that is
 * one directory off leaves the user exactly as stuck as before. These are the
 * roots worth searching -- both small, both specific to a sandboxed Zotero.
 */
export function searchRoots(home: string): string[] {
  return [`${home}/.var/app/org.zotero.Zotero`, `${home}/snap`];
}

/**
 * Directories never worth descending into while looking for zotero.sqlite.
 *
 * `storage` is the one that matters: it holds one directory per attachment, so
 * a library of two thousand PDFs is two thousand directories that cannot
 * contain the database and would dominate the search.
 */
export const SKIP_DIRS = new Set(["storage", "cache", "Cache", "locate", "translators", "styles"]);

/** How many directories a search may visit before giving up. */
export const SCAN_BUDGET = 400;

/**
 * The user's own library, not a group library they subscribe to.
 *
 * The HTTP route asks for `users/0`, which is the personal library and nothing
 * else. Reading every library here instead would quietly widen the search --
 * and a search that returns a colleague's shared group items when the user
 * believes it read their own library is worse than one that returns nothing.
 */
const USER_LIBRARY = "(SELECT libraryID FROM libraries WHERE type = 'user' ORDER BY libraryID LIMIT 1)";

/** Trashed items still have rows; only `deletedItems` says they are gone. */
const NOT_TRASHED = "i.itemID NOT IN (SELECT itemID FROM deletedItems)";

/**
 * Children of real items, which are not results.
 *
 * The API route drops these twice over -- once in the query, once in
 * `parseItems` -- because a reply listing "PDF" and "Note" rows beside their
 * parents reads as duplicated results. Same rule here, in the one place a row
 * can enter.
 */
const NOT_A_CHILD = "t.typeName NOT IN ('attachment', 'note', 'annotation')";

export const COLLECTIONS_SQL = `
  SELECT c.key AS key, c.collectionName AS name, p.key AS parent
  FROM collections c
  LEFT JOIN collections p ON p.collectionID = c.parentCollectionID
  WHERE c.libraryID = ${USER_LIBRARY}
    AND c.collectionID NOT IN (SELECT collectionID FROM deletedCollections)
  ORDER BY c.collectionName COLLATE NOCASE
`;

/**
 * How many real items the library holds, by the same rules a search uses.
 *
 * For the check in Settings, which has to answer a question the user actually
 * has: "did it find MY library?" A path is not an answer to that -- a stale
 * copy of a library restored from a backup has a perfectly good path -- and a
 * number the user recognises is.
 */
export const ITEM_COUNT_SQL = `
  SELECT COUNT(*) AS n
  FROM items i
  JOIN itemTypes t ON t.itemTypeID = i.itemTypeID
  WHERE i.libraryID = ${USER_LIBRARY}
    AND ${NOT_TRASHED}
    AND ${NOT_A_CHILD}
`;

/**
 * The words a query has to match, all of them.
 *
 * Zotero's own quick search splits on spaces and requires every part, which is
 * why "chi hattie 2011" finds one paper rather than several thousand. Matching
 * the whole string as one substring instead would find nothing at all for that
 * query, which is the more surprising failure.
 *
 * Capped, because each term is another pass over the library and a paragraph
 * pasted into the search box is a mistake rather than a query.
 */
export function searchTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const raw of query.split(/\s+/)) {
    const term = raw.trim();
    if (term) seen.add(term.toLowerCase());
    if (seen.size >= 12) break;
  }
  return [...seen];
}

/**
 * Which items match one term.
 *
 * Four places a term can hit, in the shape `qmode=everything` describes:
 * stored fields, creators' names, tags, and the text of child notes. Bound as
 * one `%term%` parameter repeated, so the term never becomes part of the SQL.
 *
 * `titleCreatorYear` narrows to what its name says, for the case the API mode
 * exists for: a common word that matches half a large library.
 *
 * NOT searched: the text inside PDFs. Zotero's full-text index stores words,
 * not text, in a form that answers "which items contain this word" only for
 * whole words it has already tokenised -- the API's `everything` reaches it and
 * this route cannot. The reply says so rather than letting a thinner search
 * pass for the wider one.
 */
export function matchSql(mode: SearchMode): string {
  const fields =
    mode === "titleCreatorYear"
      ? "AND f.fieldName IN ('title', 'shortTitle', 'date')"
      : "";
  const extras =
    mode === "titleCreatorYear"
      ? ""
      : `
      UNION
      SELECT it.itemID FROM itemTags it
      JOIN tags tg ON tg.tagID = it.tagID
      WHERE tg.name LIKE :like ESCAPE '\\'
      UNION
      SELECT n.parentItemID AS itemID FROM itemNotes n
      WHERE n.parentItemID IS NOT NULL AND n.note LIKE :like ESCAPE '\\'`;
  return `
    SELECT d.itemID FROM itemData d
    JOIN fields f ON f.fieldID = d.fieldID
    JOIN itemDataValues v ON v.valueID = d.valueID
    WHERE v.value LIKE :like ESCAPE '\\' ${fields}
    UNION
    SELECT ic.itemID FROM itemCreators ic
    JOIN creators cr ON cr.creatorID = ic.creatorID
    WHERE cr.lastName LIKE :like ESCAPE '\\' OR cr.firstName LIKE :like ESCAPE '\\'
    ${extras}
  `;
}

/** `%term%`, with LIKE's own wildcards in the term made literal. */
export function likeParam(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The rows to show, newest first.
 *
 * `dateModified DESC` is what the API route asks for, so the two routes put the
 * same paper at the top of the same search rather than disagreeing about which
 * result was the best one.
 */
export function rowsSql(ids: number[]): string {
  const marks = ids.map(() => "?").join(", ");
  return `
    SELECT i.itemID AS itemID, i.key AS key, t.typeName AS itemType,
           i.dateModified AS dateModified
    FROM items i
    JOIN itemTypes t ON t.itemTypeID = i.itemTypeID
    WHERE i.itemID IN (${marks})
      AND i.libraryID = ${USER_LIBRARY}
      AND ${NOT_TRASHED}
      AND ${NOT_A_CHILD}
    ORDER BY i.dateModified DESC
  `;
}

/** Every item filed in the given collections, by collection key. */
export function inCollectionsSql(keys: string[]): string {
  const marks = keys.map(() => "?").join(", ");
  return `
    SELECT ci.itemID AS itemID FROM collectionItems ci
    JOIN collections c ON c.collectionID = ci.collectionID
    WHERE c.key IN (${marks}) AND c.libraryID = ${USER_LIBRARY}
  `;
}

/** Items by their Zotero keys, in the personal library -- how a key a model names is looked up. */
export function idsByKeySql(keys: string[]): string {
  const marks = keys.map(() => "?").join(", ");
  return `SELECT itemID FROM items WHERE key IN (${marks}) AND libraryID = ${USER_LIBRARY}`;
}

export function fieldsSql(ids: number[]): string {
  const marks = ids.map(() => "?").join(", ");
  return `
    SELECT d.itemID AS itemID, f.fieldName AS fieldName, v.value AS value
    FROM itemData d
    JOIN fields f ON f.fieldID = d.fieldID
    JOIN itemDataValues v ON v.valueID = d.valueID
    WHERE d.itemID IN (${marks})
  `;
}

export function creatorsSql(ids: number[]): string {
  const marks = ids.map(() => "?").join(", ");
  return `
    SELECT ic.itemID AS itemID, cr.firstName AS firstName, cr.lastName AS lastName,
           cr.fieldMode AS fieldMode
    FROM itemCreators ic
    JOIN creators cr ON cr.creatorID = ic.creatorID
    WHERE ic.itemID IN (${marks})
    ORDER BY ic.itemID, ic.orderIndex
  `;
}

export function tagsSql(ids: number[]): string {
  const marks = ids.map(() => "?").join(", ");
  return `
    SELECT it.itemID AS itemID, tg.name AS name
    FROM itemTags it
    JOIN tags tg ON tg.tagID = it.tagID
    WHERE it.itemID IN (${marks})
    ORDER BY tg.name COLLATE NOCASE
  `;
}

export function collectionCountSql(ids: number[]): string {
  const marks = ids.map(() => "?").join(", ");
  return `
    SELECT itemID, COUNT(*) AS n FROM collectionItems
    WHERE itemID IN (${marks}) GROUP BY itemID
  `;
}

/**
 * Bindings per statement, kept under SQLite's parameter ceiling.
 *
 * A library of ten thousand papers and a one-word query produce an id list
 * far past the limit on host parameters, and the failure is a thrown error
 * rather than a truncated result -- so the query is run in batches and the
 * pieces are put back together here.
 */
export const BATCH = 400;

export function chunk<T>(items: T[], size = BATCH): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** One item's rows, gathered from the several queries above. */
export interface ItemParts {
  key: string;
  itemType: string;
  fields: Record<string, string>;
  creators: { firstName: string; lastName: string; fieldMode: number }[];
  tags: string[];
  collections: number;
}

/**
 * The same LibraryItem the API route produces, from the database's rows.
 *
 * Deliberately routed through `formatCreators` and `yearOf` rather than
 * reimplemented: the two routes must not disagree about how an author list or a
 * date is read, or the same paper would be cited two different ways depending
 * on whether Zotero happened to be reachable.
 */
export function shapeItem(parts: ItemParts): LibraryItem {
  const f = parts.fields;
  const pick = (...names: string[]): string => {
    for (const name of names) {
      const value = (f[name] ?? "").trim();
      if (value) return value;
    }
    return "";
  };
  return {
    key: parts.key,
    itemType: parts.itemType,
    title: pick("title"),
    /* Zotero's two creator shapes: two-field, and single-field where fieldMode
       is 1 and the whole name sits in lastName. The API sends those as
       `firstName`/`lastName` and `name` respectively, so they are rebuilt in
       that shape and handed to the same formatter. */
    creators: formatCreators(
      parts.creators.map((c) =>
        c.fieldMode === 1
          ? { name: c.lastName }
          : { firstName: c.firstName, lastName: c.lastName },
      ),
    ),
    year: yearOf({ date: pick("date") }, {}),
    abstract: pick("abstractNote"),
    publication: pick("publicationTitle", "bookTitle", "proceedingsTitle", "repository"),
    doi: pick("DOI"),
    url: pick("url"),
    tags: parts.tags,
    collections: parts.collections,
  };
}

/**
 * What the reply must say about having read the file instead of the API.
 *
 * Not a footnote. The two routes do not search the same thing -- this one
 * cannot reach the text inside PDFs -- and a user who believes their PDFs were
 * searched will read "nothing matched" as "it is not in my library".
 */
export const DATABASE_ROUTE_NOTE =
  "Read directly from Zotero's database file, because Zotero's local API was not reachable " +
  "(its own sandbox blocks it when Zotero is installed as a Flatpak or Snap). Titles, " +
  "abstracts, authors, tags and note text were searched; the text inside attached PDFs was " +
  "NOT, so say that a search found nothing only in those terms.";
