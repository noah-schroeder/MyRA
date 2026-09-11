/**
 * How a database client gets its API key, without core ever knowing there is
 * a keyring.
 *
 * `src/core/` must never import `electron`, and the vault lives in
 * `main/secrets.ts` because it does. So main installs a reader here once, at
 * startup -- the same shape as `setEndpointResolver` and the `() =>
 * vault.get("hfToken")` thunk handed to `installRuntimeIpc`. Core asks for a
 * key by name and gets a string or nothing back; it never learns there is a
 * keyring, let alone what backs it.
 *
 * Read at request time, never cached here -- a key entered in Settings has to
 * work on the very next search with no restart, the same reason
 * `readResearchConfig` re-reads its file on every call rather than once at
 * import time.
 */

import type { DatabaseSecret } from "./databases.ts";

type KeyReader = (secret: DatabaseSecret) => Promise<string | undefined>;

/* Nothing by default, so a keyed database is simply unavailable rather than
   sending an empty Authorization header and reading the 401 that follows as
   an outage. Tests that never call setDatabaseKeys get this behaviour for
   free -- a keyed provider is silently unusable, never silently wrong. */
let reader: KeyReader = () => Promise.resolve(undefined);

export function setDatabaseKeys(read: KeyReader): void {
  reader = read;
}

export async function databaseKey(secret: DatabaseSecret): Promise<string | undefined> {
  return reader(secret);
}

export async function hasDatabaseKey(secret: DatabaseSecret): Promise<boolean> {
  return Boolean(await reader(secret));
}

/** Tests only, to restore the default no-key reader between cases. */
export function resetDatabaseKeys(): void {
  reader = () => Promise.resolve(undefined);
}
