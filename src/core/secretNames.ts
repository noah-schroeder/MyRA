/**
 * What may be stored in the vault, and under what name.
 *
 * Apart from the vault itself, which cannot be loaded outside Electron -- it
 * imports safeStorage -- and this is a rule worth testing directly. It is the
 * check at the IPC boundary: a name arrives from the renderer as a string, and
 * casting it to SecretName asserts something about it rather than establishing
 * it.
 */

/** Logical secret names, plus one key per configured provider. */
export type SecretName =
  | "llmKey" | "transcriptionKey" | "embedKey" | "bridgeToken" | "hfToken"
  | `provider:${string}`;

const NAMED: readonly string[] = [
  "llmKey", "transcriptionKey", "embedKey", "bridgeToken", "hfToken",
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
