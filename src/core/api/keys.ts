/**
 * The keys other apps use to reach Karen.
 *
 * Karen issues its own keys rather than sharing Lemonade's, and the difference
 * matters: Lemonade's key is a single key with no scopes that grants
 * `/api/v1/install`, `/api/v1/pull` and `DELETE /api/v1/models/*` alongside
 * chat. A Karen key reaches only the routes in `routes.ts`, can be named, can
 * be revoked one at a time, and can be counted.
 *
 * ## Only the hash is stored
 *
 * The plaintext exists once, in memory, at the moment of creation, and is
 * shown to the user exactly once. What lands on disk is a SHA-256 hash, so a
 * stolen `api.json` grants nothing. This also means Karen genuinely cannot
 * show a key a second time -- the UI should say that plainly rather than
 * imply it is a policy choice.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * `sk-karen-` then 32 bytes of base64url.
 *
 * The prefix is not decoration: it is what makes a leaked key greppable in a
 * log or a repository, and it tells someone who finds one in a config file
 * what it opens. 32 bytes because these are bearer tokens on a socket that may
 * be published to a LAN.
 */
export const KEY_PREFIX = "sk-karen-";
const KEY_BYTES = 32;

export interface ApiKey {
  id: string;
  /** What the user called it: "Obsidian", "notebook". */
  label: string;
  /** SHA-256 of the plaintext, hex. The plaintext is never stored. */
  hash: string;
  /** Enough to recognise a key in a list without being enough to use it. */
  tail: string;
  createdAt: string;
  lastUsedAt?: string | undefined;
  requests: number;
}

/** A newly minted key: the record to store, and the secret to show once. */
export interface MintedKey {
  key: ApiKey;
  secret: string;
}

export function hashKey(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function mintKey(label: string, now = new Date()): MintedKey {
  const secret = KEY_PREFIX + randomBytes(KEY_BYTES).toString("base64url");
  return {
    secret,
    key: {
      id: randomBytes(8).toString("hex"),
      label: label.trim() || "Unnamed key",
      hash: hashKey(secret),
      tail: secret.slice(-4),
      createdAt: now.toISOString(),
      requests: 0,
    },
  };
}

/** `sk-karen-…a3f9`, for a list where the whole key must never appear. */
export function displayKey(key: ApiKey): string {
  return `${KEY_PREFIX}…${key.tail}`;
}

/**
 * Find the key a request presented, in constant time.
 *
 * Every candidate is compared even after a match, and the comparison itself is
 * `timingSafeEqual`, so neither the answer nor the position of the matching
 * key can be recovered by timing the request. Hashes are fixed-length hex, so
 * the length-mismatch escape hatch that usually defeats this cannot be reached.
 */
export function findKey(keys: readonly ApiKey[], presented: string): ApiKey | undefined {
  const offered = Buffer.from(hashKey(presented), "utf8");
  let found: ApiKey | undefined;
  for (const key of keys) {
    const stored = Buffer.from(key.hash, "utf8");
    if (stored.length === offered.length && timingSafeEqual(stored, offered)) found = key;
  }
  return found;
}

/**
 * The bearer token in a request's headers.
 *
 * Three spellings are accepted because three ecosystems each chose their own:
 * OpenAI clients send `Authorization: Bearer`, Anthropic's SDK sends
 * `x-api-key`, and a good deal of tooling sends `api-key`. Rejecting a valid
 * key because the client picked a different header would be a support burden
 * with no security benefit -- the key is the same secret either way.
 */
export function bearerFrom(headers: Record<string, string | string[] | undefined>): string {
  const one = (v: string | string[] | undefined): string =>
    (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
  const auth = one(headers["authorization"]);
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m?.[1]) return m[1].trim();
    return auth;
  }
  return one(headers["x-api-key"]) || one(headers["api-key"]);
}
