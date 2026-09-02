/**
 * One library, two ways in, and a rule about which.
 *
 * The local HTTP API is preferred whenever it answers: it is Zotero's own
 * supported interface, it reflects the library as it is this second, and its
 * `everything` search reaches the indexed text inside attached PDFs, which
 * nothing outside Zotero can reproduce.
 *
 * When it does not answer, the database file is read instead. That case is not
 * exotic: a Zotero installed as a Flatpak or a Snap holds the port inside its
 * own network namespace, so the API is running, Zotero's settings pane says so
 * truthfully, and no other process on the machine can reach it. Before this,
 * Karen's answer to that was "Zotero does not appear to be running" -- said to
 * someone looking straight at it.
 *
 * The route is never silent. The two do not search the same thing, and a user
 * who thinks their PDFs were searched will read "nothing matched" as "it is not
 * in my library".
 */

import { listZoteroCollections, searchZotero } from "./zoteroClient.ts";
import { collectionsFromDb, findZoteroDataDir, searchDb } from "./zoteroSqlite.ts";
import { ZoteroError, type LibraryItem, type SearchMode, type ZoteroCollection } from "../../core/library/zotero.ts";

export type Route = "api" | "database";

let route: Route = "api";

/** How the last read was served, for the reply to say so. */
export function libraryRoute(): Route {
  return route;
}

/**
 * How long a refusal from the API is believed before asking it again.
 *
 * Asking costs two connection attempts with a five second timeout each, and a
 * sandboxed Zotero refuses every one of them. Paying twenty seconds per search
 * to re-learn the same fact would make the fallback worse than useless on the
 * installs that need it. Short enough that starting Zotero properly is noticed
 * within a minute.
 */
const RETRY_API_AFTER_MS = 60_000;
let apiFailedAt = 0;

function apiWorthTrying(): boolean {
  return Date.now() - apiFailedAt > RETRY_API_AFTER_MS;
}

/**
 * The API, then the file.
 *
 * Both errors are kept: "Zotero is not reachable" and "and there is no library
 * file either" are different problems with different fixes, and a message that
 * reported only the second would send someone looking for a data directory when
 * the real answer is to open Zotero.
 */
async function either<T>(
  viaApi: () => Promise<T>,
  viaDb: () => Promise<T>,
): Promise<T> {
  if (apiWorthTrying()) {
    try {
      const value = await viaApi();
      route = "api";
      apiFailedAt = 0;
      return value;
    } catch (err) {
      if (!(err instanceof ZoteroError)) throw err;
      apiFailedAt = Date.now();
      /* No library file to fall back to: the API's own message is the useful
         one, because it says what to do about Zotero. */
      if (!findZoteroDataDir()) throw err;
      try {
        const value = await viaDb();
        route = "database";
        return value;
      } catch (dbErr) {
        throw new ZoteroError(
          `${err.message}\n\nKaren also tried reading Zotero's database file directly, and ` +
            `that failed too: ${(dbErr as Error).message}`,
          err.status,
        );
      }
    }
  }
  const value = await viaDb();
  route = "database";
  return value;
}

export async function libraryCollections(): Promise<ZoteroCollection[]> {
  return either(listZoteroCollections, collectionsFromDb);
}

export async function librarySearch(opts: {
  query: string;
  limit?: number;
  mode?: SearchMode;
  collections?: string[];
}): Promise<LibraryItem[]> {
  return either(
    () => searchZotero(opts),
    () => searchDb(opts),
  );
}
