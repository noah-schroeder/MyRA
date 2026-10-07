/**
 * Where a request went, read off the address it was sent to.
 *
 * The call that reports usage knows only a base URL and a model name -- the
 * provider was resolved further up and not passed down, and passing it down
 * would mean every resolver branch and every caller agreeing to carry it. The
 * address is enough: the runtime's own port, a provider's configured URL or the
 * single endpoint in Settings are each distinct, and anything that matches none
 * of them is judged by the same loopback rule the privacy report uses.
 *
 * "Local" here is exactly what it is everywhere else in the app
 * (`effectiveKind`): on this machine AND called local. A provider somebody
 * labelled local on a LAN address is external on this page too, because the
 * page would otherwise contradict the warning beside the model picker.
 */

import { effectiveKind, providerName, urlIsLocal, type Provider } from "../providers.ts";
import type { UsageWhere } from "./record.ts";

export interface EndpointContext {
  providers: Provider[];
  /** MyRA's own runtime, when it is serving -- the port changes every launch. */
  runtimeBaseUrl?: string | undefined;
  /** The single endpoint in Settings, the fallback branch of the resolver. */
  llmBaseUrl?: string | undefined;
}

export interface Classified {
  provider: { id: string; name: string };
  where: UsageWhere;
  price?: { input: number; output: number };
}

/** The runtime's display name, used as its provider. */
export const THIS_COMPUTER = "This computer";

/**
 * Compare addresses as a person would: case-insensitive host, no trailing
 * slash, and `/v1` optional, since chat.ts accepts both spellings of every
 * base URL and a provider saved as one must match a request sent as the other.
 */
export function sameEndpoint(a: string, b: string): boolean {
  const norm = (u: string): string => {
    try {
      const url = new URL(u.trim());
      const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
      return `${url.protocol}//${url.host.toLowerCase()}${path}`;
    } catch {
      return u.trim().replace(/\/+$/, "").replace(/\/v1$/, "").toLowerCase();
    }
  };
  return Boolean(a.trim() && b.trim()) && norm(a) === norm(b);
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl;
  }
}

export function classifyEndpoint(baseUrl: string, model: string, ctx: EndpointContext): Classified {
  /* The runtime is listed by origin, since Lemonade serves its dialects under
     different roots on one port and the gateway forwards to all of them. */
  if (ctx.runtimeBaseUrl && sameOrigin(baseUrl, ctx.runtimeBaseUrl)) {
    return { provider: { id: "", name: THIS_COMPUTER }, where: "local" };
  }
  const provider = ctx.providers.find((p) => sameEndpoint(p.baseUrl, baseUrl));
  if (provider) {
    const price = provider.prices?.[model];
    return {
      provider: { id: provider.id, name: providerName(provider) },
      where: effectiveKind(provider),
      ...(price ? { price: { input: price.input, output: price.output } } : {}),
    };
  }
  const where: UsageWhere = urlIsLocal(baseUrl) ? "local" : "external";
  if (ctx.llmBaseUrl && sameEndpoint(ctx.llmBaseUrl, baseUrl)) {
    return { provider: { id: "llm", name: `Your endpoint (${hostOf(baseUrl)})` }, where };
  }
  return { provider: { id: `url:${hostOf(baseUrl)}`, name: hostOf(baseUrl) }, where };
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
