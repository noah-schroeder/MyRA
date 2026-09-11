/**
 * The one place MyRA talks to Zotero.
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
  ZOTERO_HOSTS, ZOTERO_PORT,
  type LibraryItem, type QueryTier, type SearchMode, type ZoteroCollection,
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
/**
 * Which loopback address answered last time.
 *
 * Remembered for the session so a library search is one request rather than a
 * failed one followed by a real one. Reset on a connection failure, because the
 * address that worked is exactly the thing that has changed when Zotero is
 * restarted differently.
 */
let reachedAt: string | undefined;

async function get(path: string): Promise<unknown> {
  /* Both loopback families, the one that worked last time first.
     Zotero's settings pane says "localhost", which is two addresses, and a
     server bound to only the v6 one was reported as not running. */
  const hosts = reachedAt ? [reachedAt, ...ZOTERO_HOSTS.filter((h) => h !== reachedAt)] : [...ZOTERO_HOSTS];

  let res: Response | undefined;
  for (const host of hosts) {
    try {
      res = await fetch(`http://${host}:${ZOTERO_PORT}${path}`, {
        headers: {
          // The version Zotero's local API speaks. Sent explicitly so a future
          // Zotero that changes its default shape does not silently change ours.
          "zotero-api-version": "3",
          accept: "application/json",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      reachedAt = host;
      break;
    } catch {
      /* Connection refused, timeout -- indistinguishable here, and both mean
         this address is not the one. Try the other before giving up. */
      reachedAt = undefined;
    }
  }

  if (!res) {
    /* `undefined` is what describeFailure renders as "not reachable", and it
       now names both addresses rather than the one MyRA used to try. */
    throw new ZoteroError(describeFailure(undefined));
  }

  if (!res.ok) {
    // Read before throwing: the body is where Zotero says what it objected to.
    const body = await res.text().catch(() => "");
    throw new ZoteroError(describeFailure(res.status, body), res.status);
  }

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
/**
 * Ask for the search, and if the request itself is refused, ask for less.
 *
 * The collection listing works on installs where the search does not, and the
 * two differ only in the query string -- same host, same port, same `/api/`
 * prefix, same function below. So the extras are what a refusal is about, and
 * dropping them is a search that works rather than an error that explains.
 *
 * Only for a refusal of the REQUEST. A 403 is the local API switched off and a
 * 404 is a Zotero too old; both have messages that name the fix, and retrying
 * either would replace an answer the user can act on with one they cannot.
 */
async function searchOnce(path: (tier: QueryTier) => string): Promise<{
  body: unknown;
  tier: QueryTier;
}> {
  try {
    return { body: await get(path("full")), tier: "full" };
  } catch (err) {
    const status = err instanceof ZoteroError ? err.status : undefined;
    if (status === undefined || status === 403 || status === 404) throw err;
    return { body: await get(path("plain")), tier: "plain" };
  }
}

export async function searchZotero(opts: {
  query: string;
  limit?: number;
  mode?: SearchMode;
  collections?: string[];
}): Promise<LibraryItem[]> {
  const { collections, ...rest } = opts;
  if (!collections?.length) {
    return parseItems((await searchOnce((tier) => searchPath(rest, tier))).body);
  }

  const pages = (
    await Promise.all(
      collections.map((collection) =>
        searchOnce((tier) => searchPath({ ...rest, collection }, tier)),
      ),
    )
  ).map((r) => r.body);

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
