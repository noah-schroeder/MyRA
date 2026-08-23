/**
 * Every network call the app makes itself.
 *
 * The egress filter hooks `session.webRequest`, which only sees Chromium's
 * network stack -- renderer requests. The main process's `fetch` is Node's, and
 * it goes nowhere near a session. Verified rather than assumed: with the filter
 * cancelling *every* request, a main-process fetch still returned 200 and the
 * filter never saw it.
 *
 * So the app's own calls -- transcription, meeting notes, endpoint tests -- were
 * outside both the allowlist and the Network Activity panel. Neither was a leak
 * in practice, because every URL comes from the user's own settings, but two
 * stated guarantees were narrower than they claimed: "default-deny" could not
 * deny what it never saw, and a panel promising to log every outbound
 * connection was not logging these.
 *
 * This routes them through the same decision and the same log, so the allowlist
 * is authoritative for the whole app rather than for one half of it.
 */

import type { EgressFilter } from "./egress.ts";
import { asSeenFromHost } from "../shared/hostAddress.ts";

export class EgressBlocked extends Error {
  override readonly name = "EgressBlocked";
}

let filter: EgressFilter | undefined;

/** Called once at startup, with the same filter the session uses. */
export function useEgressFilter(next: EgressFilter): void {
  filter = next;
}

/**
 * fetch, decided and recorded.
 *
 * Fails closed: with no filter installed nothing is allowed out, because the
 * only way that happens is a startup path that forgot to install one, and a
 * quiet exception beats a silent unfiltered request.
 */
export async function appFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!filter) throw new EgressBlocked("the egress filter is not installed yet");

  // Endpoint settings hold the VM's view of a server. From here, the QEMU
  // gateway is a network this machine is not on -- see hostAddress.ts.
  const target = asSeenFromHost(url);

  const { allowed, reason } = filter.evaluate(target);
  filter.record(target, allowed, `app: ${reason}`);
  if (!allowed) {
    throw new EgressBlocked(
      `${new URL(target).origin} is not a configured endpoint, so the app did not contact it`,
    );
  }
  return await fetch(target, init);
}
