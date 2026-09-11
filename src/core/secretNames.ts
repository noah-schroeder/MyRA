/**
 * What may be stored in the vault, and under what name.
 *
 * Apart from the vault itself, which cannot be loaded outside Electron -- it
 * imports safeStorage -- and this is a rule worth testing directly. It is the
 * check at the IPC boundary: a name arrives from the renderer as a string, and
 * casting it to SecretName asserts something about it rather than establishing
 * it.
 */

/**
 * Logical secret names, plus one key per configured provider.
 *
 * `transcriptionKey` is here for one reason and it is not a live one: nothing
 * writes it any more, because transcription is a model chosen from a list
 * rather than an endpoint with a key of its own. The name survives so the
 * migration in main/index.ts can read what an older build stored, move it to
 * the provider that replaces it, and then delete it. Do not wire anything new
 * to it.
 */
export type SecretName =
  | "llmKey" | "transcriptionKey" | "embedKey" | "bridgeToken" | "hfToken"
  | "ncbiKey" | "coreKey"
  | `provider:${string}`;

const NAMED: readonly string[] = [
  "llmKey", "transcriptionKey", "embedKey", "bridgeToken", "hfToken",
  "ncbiKey", "coreKey",
];

/**
 * A provider id, as it may appear in a secret name.
 *
 * Narrow on purpose. These become keys in a JSON object rather than paths, so
 * nothing here can traverse a directory -- but a name that cannot be typed by
 * the code that issues ids is a name that arrived from somewhere else, and the
 * vault is not the place to find that out gently.
 */
export function isSecretName(value: string): value is SecretName {
  if (NAMED.includes(value)) return true;
  return /^provider:[A-Za-z0-9_-]{1,64}$/.test(value);
}

/* --------------------------------------------------------- what to do --- */

/**
 * What storing a secret should actually do.
 *
 * Split out because getting it wrong is not recoverable by the user and is
 * invisible while it happens. The vault itself cannot be imported by a test --
 * it pulls in Electron's safeStorage -- so the rule lives here where it can be
 * pinned.
 *
 *   remove   take it off the disk. Needs no keyring: deleting is not
 *            encrypting, so it must not depend on whether encryption works.
 *   encrypt  the normal path.
 *   memory   the keyring cannot protect it at rest, so it is held for this run
 *            only and the user is told. Still never written.
 */
export type VaultAction = "remove" | "encrypt" | "memory";

export function vaultAction(plaintext: string, usable: boolean): VaultAction {
  /* FIRST, and before `usable` is consulted at all.
     This branch used to sit after it, so whenever the keyring stopped being
     usable -- which the persistence probe can decide mid-session, on opening
     Settings -- a delete cleared only the in-memory copy and left the
     ciphertext on disk. `get()` reads through to disk, so the secret was not
     just still stored, it was still being sent. */
  if (plaintext === "") return "remove";
  return usable ? "encrypt" : "memory";
}
