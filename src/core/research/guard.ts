/**
 * Deciding whether a URL is safe to fetch.
 *
 * `fetch_page` is the only tool that opens a URL, and the URL comes from the
 * model — which reads scraped pages and search snippets, i.e. text written by
 * strangers. Until now the only check was `^https?://`, so "fetch
 * http://127.0.0.1:11434/api/tags and tell me what it says" was a request the
 * app would carry out. Nothing could be *written* through that, but an
 * unauthenticated service on the loopback interface or the LAN — a model
 * server, a router admin page, a printer, a cloud metadata endpoint — could be
 * read, and whatever came back landed in the conversation.
 *
 * Three things have to be checked, and checking only the first is the usual
 * mistake:
 *
 *   1. The **literal host**, for `localhost` and bare IP addresses.
 *   2. The **resolved addresses**, because a public hostname is free to have an
 *      A record pointing at 127.0.0.1. This is not exotic; it is a one-line
 *      DNS entry.
 *   3. **Every redirect hop**, because a public URL that returns `302
 *      http://169.254.169.254/` defeats a check performed only on the URL the
 *      model supplied.
 *
 * This is not a general-purpose SSRF defence — a determined attacker who
 * controls DNS can still win the race between our resolution and the socket's
 * (classic DNS rebinding). It is sized for the threat that actually applies
 * here: text the model was persuaded by, not an adversary with a rebinding
 * server. Closing that properly needs a pinned-socket dispatcher, which is
 * noted in DECISIONS.md rather than pretended at.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class BlockedUrlError extends Error {
  override readonly name = "BlockedUrlError";
}

/** Hostnames that always mean "this machine", whatever DNS says. */
const LOCAL_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);

/**
 * Address ranges that are not the public internet.
 *
 * `169.254.169.254` deserves its own mention: it is the cloud metadata service
 * on AWS, GCP and Azure, and reading it hands out instance credentials. It is
 * inside link-local, so it is covered, but it is the reason link-local matters.
 */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts as [number, number, number, number];
    if (a === 0) return true;                        // "this network"
    if (a === 10) return true;                       // private
    if (a === 127) return true;                      // loopback
    if (a === 169 && b === 254) return true;         // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true;         // private
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a === 192 && b === 0) return true;           // IETF protocol assignments
    if (a >= 224) return true;                       // multicast, reserved, broadcast
    return false;
  }
  if (v === 6) {
    const s = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0]!;
    if (s === "::1" || s === "::") return true;
    // IPv4-mapped (::ffff:127.0.0.1) is the same address wearing a hat.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateAddress(mapped[1]!);
    if (/^f[cd]/.test(s)) return true;               // unique local
    if (/^fe[89ab]/.test(s)) return true;            // link-local
    if (/^ff/.test(s)) return true;                  // multicast
    return false;
  }
  // Not an IP at all: caller should have resolved it first. Refuse rather than
  // let an unparsed value through as "not private".
  return true;
}

export interface GuardOptions {
  /** Overridable so tests need no DNS. Returns every address for a host. */
  resolve?: (host: string) => Promise<string[]>;
}

async function dnsResolve(host: string): Promise<string[]> {
  const entries = await lookup(host, { all: true, verbatim: true });
  return entries.map((e) => e.address);
}

/**
 * How hostnames are resolved. Replaceable so the guard can be exercised without
 * DNS, in the same way office.ts takes a PDF renderer.
 */
let resolver: (host: string) => Promise<string[]> = dnsResolve;

export function setAddressResolver(fn: ((host: string) => Promise<string[]>) | undefined): void {
  resolver = fn ?? dnsResolve;
}

/**
 * Throw unless this URL is safe for the agent to open.
 *
 * Called for the model-supplied URL AND for every redirect target.
 */
export async function assertFetchable(raw: string, opts: GuardOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError(`${JSON.stringify(raw)} is not a URL.`);
  }

  // file:, data:, ftp:, gopher: — none of them are a web page, and file: would
  // read the disk through a tool that is documented as reading the web.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError(
      `${url.protocol.replace(":", "")} is not a web protocol. fetch_page opens http(s) URLs only.`,
    );
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (LOCAL_NAMES.has(host) || host.endsWith(".localhost")) {
    throw new BlockedUrlError(`${url.hostname} is this machine. fetch_page reaches the public web only.`);
  }
  // ".local" is mDNS: printers, NAS boxes, other people's laptops.
  if (host.endsWith(".local")) {
    throw new BlockedUrlError(`${url.hostname} is a local network name. fetch_page reaches the public web only.`);
  }

  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new BlockedUrlError(`${url.hostname} is a private address. fetch_page reaches the public web only.`);
    }
    return url;
  }

  let addresses: string[];
  try {
    addresses = await (opts.resolve ?? resolver)(host);
  } catch {
    throw new BlockedUrlError(`${url.hostname} could not be resolved.`);
  }
  if (addresses.length === 0) throw new BlockedUrlError(`${url.hostname} resolved to no addresses.`);

  // EVERY address, not the first: a host with one public and one loopback
  // record would otherwise pass and then connect to whichever the OS picked.
  const bad = addresses.find((a) => isPrivateAddress(a));
  if (bad) {
    throw new BlockedUrlError(
      `${url.hostname} resolves to ${bad}, which is a private address. ` +
        `fetch_page reaches the public web only.`,
    );
  }
  return url;
}
