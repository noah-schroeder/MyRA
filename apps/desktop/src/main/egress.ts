/**
 * Default-deny network filter for the desktop app.
 *
 * The host app has no business browsing. Its entire legitimate network life is:
 *   - the transcription endpoint the user configured
 *   - its own loopback bridge socket (and, in development, the Vite dev server)
 *
 * Everything else -- CDN fonts, telemetry, component updates, Chromium's
 * spellcheck dictionary fetches from Google -- is cancelled here rather than
 * merely discouraged, so the privacy guarantee is structural.
 *
 * This is NOT a browsing filter. Research fetching happens in pi's tools inside
 * the VM, a different process on a different machine, and never passes through
 * this layer. The user never adds a website to any list.
 */

import type { Session } from "electron";

export interface EgressDecision {
  at: number;
  url: string;
  allowed: boolean;
  reason: string;
}

/** Schemes that never touch the network and so are not the filter's concern. */
const LOCAL_SCHEMES = new Set(["file:", "data:", "blob:", "devtools:", "about:", "chrome:", "chrome-extension:"]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export class EgressFilter {
  #allowedOrigins = new Set<string>();
  #log: EgressDecision[] = [];
  readonly #maxLog: number;
  #allowLoopback: boolean;

  constructor(opts: { maxLog?: number; allowLoopback?: boolean } = {}) {
    this.#maxLog = opts.maxLog ?? 500;
    this.#allowLoopback = opts.allowLoopback ?? true;
  }

  /**
   * Replace the allowlist. Derived automatically from the user's endpoint
   * settings -- there is no hand-maintained list anywhere in the product.
   */
  setAllowedEndpoints(urls: string[]): void {
    this.#allowedOrigins = new Set();
    for (const raw of urls) {
      if (!raw) continue;
      try {
        this.#allowedOrigins.add(new URL(raw).origin);
      } catch {
        // An unparseable endpoint simply grants nothing.
      }
    }
  }

  get allowedOrigins(): string[] {
    return [...this.#allowedOrigins];
  }

  get activity(): EgressDecision[] {
    return [...this.#log];
  }

  clearActivity(): void {
    this.#log = [];
  }

  /**
   * Record a decision made elsewhere.
   *
   * Public because the app's own fetches do not pass through webRequest and
   * must still appear in the activity log -- see appFetch.ts.
   */
  record(url: string, allowed: boolean, reason: string): void {
    this.#record(url, allowed, reason);
  }

  #record(url: string, allowed: boolean, reason: string): void {
    this.#log.push({ at: Date.now(), url, allowed, reason });
    if (this.#log.length > this.#maxLog) this.#log.splice(0, this.#log.length - this.#maxLog);
  }

  evaluate(rawUrl: string): { allowed: boolean; reason: string } {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { allowed: false, reason: "unparseable URL" };
    }

    if (LOCAL_SCHEMES.has(url.protocol)) {
      return { allowed: true, reason: "local scheme" };
    }

    if (this.#allowLoopback && LOOPBACK_HOSTS.has(url.hostname)) {
      return { allowed: true, reason: "loopback" };
    }

    if (this.#allowedOrigins.has(url.origin)) {
      return { allowed: true, reason: "configured endpoint" };
    }

    return { allowed: false, reason: "not on the endpoint allowlist" };
  }

  /** Attach to a session. Every request is decided; none is merely observed. */
  install(session: Session): void {
    session.webRequest.onBeforeRequest((details, callback) => {
      const { allowed, reason } = this.evaluate(details.url);
      // Local schemes are the overwhelming majority; logging them would bury
      // the signal the Network Activity panel exists to show.
      if (reason !== "local scheme") this.#record(details.url, allowed, reason);
      callback({ cancel: !allowed });
    });

    // Chromium fetches spellcheck dictionaries from Google unless this is
    // cleared. It is the leak most Electron apps ship with unknowingly.
    session.setSpellCheckerDictionaryDownloadURL("https://invalid.invalid/");
    session.setSpellCheckerEnabled(false);
  }
}
