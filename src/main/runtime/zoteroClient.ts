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
  describeFailure, parseItems, searchPath, ZoteroError, ZOTERO_HOST, ZOTERO_PORT,
  type LibraryItem, type SearchMode,
} from "../../core/library/zotero.ts";

/**
 * Short.
 *
 * Zotero is answering from a local SQLite database on the same machine; a
 * request that has not come back in five seconds is not slow, it is a Zotero
 * that is busy syncing or wedged, and a chat turn should not sit on it.
 */
const TIMEOUT_MS = 5_000;

export async function searchZotero(opts: {
  query: string;
  limit?: number;
  mode?: SearchMode;
}): Promise<LibraryItem[]> {
  const url = `http://${ZOTERO_HOST}:${ZOTERO_PORT}${searchPath(opts)}`;

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

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ZoteroError("Zotero answered with something that was not JSON.");
  }
  return parseItems(body);
}
