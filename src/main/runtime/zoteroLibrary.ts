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
 * MyRA's answer to that was "Zotero does not appear to be running" -- said to
 * someone looking straight at it.
 *
 * The route is never silent. The two do not search the same thing, and a user
 * who thinks their PDFs were searched will read "nothing matched" as "it is not
 * in my library".
 */

import { listZoteroCollections, searchZotero } from "./zoteroClient.ts";
import {
  collectionsFromDb, findZoteroDataDir, inspectLibraryFile, searchDb, type DirFinding,
} from "./zoteroSqlite.ts";
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
          `${err.message}\n\nMyRA also tried reading Zotero's database file directly, and ` +
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

/**
 * Both routes, asked at once, for the panel in Settings.
 *
 * This exists because "it failed again, same reason as before" is not
 * something anyone should have to debug by reading source. The two routes fail
 * for unrelated reasons -- a switch inside Zotero, or a folder somewhere else
 * on the disk -- and a single line saying Zotero could not be reached hides
 * which of them is the problem. So both are reported, always, whether or not
 * the other one worked.
 *
 * It probes rather than reporting what the last search happened to do: a
 * status panel that showed a cached verdict would be describing the state of
 * the machine ten minutes ago, which is exactly when someone is standing there
 * having just switched the setting on in Zotero.
 */
export interface LibraryStatus {
  api: { ok: boolean; message: string; collections?: number };
  file: { ok: boolean; message: string; items?: number; collections?: number; path?: string; source?: string };
  /** Everywhere the file route looked, and what Zotero's own profiles said. */
  looked: DirFinding;
}

export async function libraryStatus(): Promise<LibraryStatus> {
  const [api, file] = await Promise.all([
    listZoteroCollections().then(
      (collections) => ({
        ok: true,
        message: `Zotero answered on the local API, with ${collections.length} collection${
          collections.length === 1 ? "" : "s"
        }. Searches will use it, including the text inside attached PDFs.`,
        collections: collections.length,
      }),
      (err: unknown) => ({ ok: false, message: err instanceof Error ? err.message : String(err) }),
    ),
    inspectLibraryFile(),
  ]);

  /* The probe is the freshest thing anyone knows about the API, so a search
     that follows immediately should not sit out the retry window learning the
     same fact again -- nor keep believing a refusal the user has just fixed. */
  apiFailedAt = api.ok ? 0 : Date.now();

  return {
    api,
    file: {
      ok: file.ok,
      message: file.message,
      ...(file.items !== undefined ? { items: file.items } : {}),
      ...(file.collections !== undefined ? { collections: file.collections } : {}),
      ...(file.found.path ? { path: file.found.path } : {}),
      ...(file.found.source ? { source: file.found.source } : {}),
    },
    looked: file.found,
  };
}
