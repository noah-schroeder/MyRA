/**
 * The one place Karen talks to Zotero.
 *
 * Deliberately narrow, on the same principle as hfClient: the host and the port
 * are constants, the path is built by `searchPath` from typed fields, and
 * nothing a caller supplies becomes part of the URL except through that. There
 * is no shape of input here that turns this into a general fetch.
 *
 * Loopback only, and no key. That is Zotero's design for the local API, and it
 * is also what makes this usable at the document rung: nothing here reaches the
 * network, so a library search is no more of an egress than opening a file.
 */

import {
  collectionsPath, describeFailure, parseCollections, parseItems, searchPath, ZoteroError,
  ZOTERO_HOST, ZOTERO_PORT,
  type LibraryItem, type SearchMode, type ZoteroCollection,
} from "../../core/library/zotero.ts";

/**
 * Short.
 *
 * Zotero is answering from a local SQLite database on the same machine; a
 * request that has not come back in five seconds is not slow, it is a Zotero
 * that is busy syncing or wedged, and a chat turn should not sit on it.
 */
const TIMEOUT_MS = 5_000;

/**
 * One GET against the local API, decoded, with the two failures kept apart.
 *
 * The path is always built by this module's own helpers from typed fields; it
 * is never assembled from a caller's string.
 */
async function get(path: string): Promise<unknown> {
  const url = `http://${ZOTERO_HOST}:${ZOTERO_PORT}${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        // The version Zotero's local API speaks. Sent explicitly so a future
        // Zotero that changes its default shape does not silently change ours.
        "zotero-api-version": "3",
        accept: "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    /* Connection refused, DNS, timeout -- all indistinguishable here and all
       meaning the same thing to the user: Zotero is not answering. `undefined`
       is what describeFailure renders as "not running". */
    throw new ZoteroError(describeFailure(undefined));
  }

  if (!res.ok) throw new ZoteroError(describeFailure(res.status));

  try {
    return await res.json();
  } catch {
    throw new ZoteroError("Zotero answered with something that was not JSON.");
  }
}

/** Every collection in the library, flat. The tree is built from `parent`. */
export async function listZoteroCollections(): Promise<ZoteroCollection[]> {
  return parseCollections(await get(collectionsPath()));
}

/**
 * Search the library, or one part of it and everything filed below that part.
 *
 * `collections` is the subtree, already resolved by the caller, and is why this
 * takes a list rather than a key: Zotero's API is not recursive, so a search of
 * "Projects" that did not also ask its subcollections would report an empty
 * collection to someone whose papers are all one level down. The requests go
 * out together -- this is loopback against SQLite -- and the results are merged
 * in the order asked, chosen collection first, then trimmed to the limit that
 * one request would have honoured.
 */
export async function searchZotero(opts: {
  query: string;
  limit?: number;
  mode?: SearchMode;
  collections?: string[];
}): Promise<LibraryItem[]> {
  const { collections, ...rest } = opts;
  if (!collections?.length) return parseItems(await get(searchPath(rest)));

  const pages = await Promise.all(
    collections.map((collection) => get(searchPath({ ...rest, collection }))),
  );

  const seen = new Set<string>();
  const merged: LibraryItem[] = [];
  for (const page of pages) {
    for (const item of parseItems(page)) {
      /* An item can be filed in a collection AND in one below it, so the same
         paper genuinely does come back twice. Showing it twice would read as
         two papers. */
      if (item.key && seen.has(item.key)) continue;
      if (item.key) seen.add(item.key);
      merged.push(item);
    }
  }
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 25), 1), 100);
  return merged.slice(0, limit);
}
