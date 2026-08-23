/**
 * The same endpoint, seen from two places.
 *
 * A model server running on the user's machine has two addresses that both
 * mean "here": the VM reaches it at 10.0.2.2, QEMU's SLIRP gateway, and the
 * machine itself reaches it at 127.0.0.1. One setting has to serve both,
 * because asking someone to enter the same server twice under two addresses is
 * a question with no good answer.
 *
 * The setting holds the VM's view, because that is what pi needs written into
 * models.json. When the desktop app makes a call of its own -- meeting notes,
 * which are generated on the host so transcripts never enter the sandbox -- it
 * translates. From the host, 10.0.2.2 is the gateway to a network it is not on,
 * and the request would fail with a connection error nobody could act on.
 */

/** QEMU user-mode networking always presents the host at this address. */
const SLIRP_GATEWAY = "10.0.2.2";

/** Rewrite a VM-facing URL to how this machine reaches the same server. */
export function asSeenFromHost(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== SLIRP_GATEWAY) return url;
    parsed.hostname = "127.0.0.1";
    return parsed.toString();
  } catch {
    // Not a URL we can reason about; leave it exactly as the user typed it.
    return url;
  }
}

/** True when this address only means anything from inside the VM. */
export function isVmOnlyAddress(url: string): boolean {
  try {
    return new URL(url).hostname === SLIRP_GATEWAY;
  } catch {
    return false;
  }
}
