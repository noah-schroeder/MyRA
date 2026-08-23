/**
 * The one rule for "may this URL be acted on".
 *
 * Two places need it and they must not disagree: the renderer decides whether a
 * link in model prose becomes clickable, and the main process decides whether
 * to hand a URL to the OS via shell.openExternal. If the renderer were the
 * stricter of the two, a URL reaching the main process by any other route would
 * still be opened.
 *
 * These URLs are attacker-influenceable. They arrive in search results, in
 * pages the agent fetched, and in model output that quotes both. Treat every
 * one as hostile.
 *
 * This is an ALLOWLIST, deliberately. A denylist of javascript:, data:, vbscript:
 * and file: loses to the next encoding trick; requiring the string to begin with
 * http:// or https:// cannot. Everything else renders as plain text and is
 * refused by the opener.
 */
export function isSafeExternalUrl(url: unknown): url is string {
  return typeof url === "string" && /^https?:\/\/[^\s]/i.test(url);
}
