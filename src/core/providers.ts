/**
 * Where a model actually runs, and therefore where a conversation goes.
 *
 * Karen's promise is that nothing leaves the machine unless the user asked for
 * it. Adding hosted models does not weaken that promise, but it does mean the
 * app can no longer answer "does this leave?" by knowing it never does. It has
 * to answer per provider, visibly, at the moment a model is chosen.
 *
 * ## The one rule that is not the user's to set
 *
 * A provider is labelled local or external by the person who added it, because
 * they know what their endpoint is. But the label can only ever make Karen MORE
 * cautious, never less: an endpoint that is not on this machine is external no
 * matter what the box says.
 *
 * That asymmetry is deliberate. A wrong "external" costs a warning nobody
 * needed. A wrong "local" is Karen telling a researcher their interview
 * transcripts stayed on their laptop while they were being posted to somebody
 * else's server — and they would have no way to find out. Those two mistakes
 * are not the same size, so they do not get the same treatment.
 */

import { isLocalHost } from "./destinations.ts";

export type ProviderKind = "local" | "external";

export interface Provider {
  /** Stable across renames; what a chosen model is qualified by. */
  id: string;
  label: string;
  /** What the user says it is. Only honoured when the endpoint agrees. */
  kind: ProviderKind;
  baseUrl: string;
  /** Which of this endpoint's models are offered in the picker. */
  models: string[];
  enabled: boolean;
}

/**
 * Whether a base URL is somewhere a request stays on this machine.
 *
 * A LAN address is NOT local here. Data sent to a box down the corridor has
 * left this computer, and the warning the user asked for — "data will be sent
 * to an external system" — is true of it. Calling that local would be splitting
 * a hair that only matters to the person who set the network up, in front of a
 * guarantee that matters to everyone else.
 */
export function urlIsLocal(baseUrl: string): boolean {
  try {
    /* destinations.ts, not a second copy of the rule. The privacy report draws
       its "local" column from that same function, and a provider the report
       called local while this called it external -- or the reverse -- would be
       the app contradicting itself about the only thing it promises. */
    return isLocalHost(new URL(baseUrl).hostname);
  } catch {
    // Unparseable, so unknowable, so treated as leaving. The safe direction.
    return false;
  }
}

/**
 * What this provider IS, as opposed to what it is labelled.
 *
 * `local` requires both: the user called it local AND the endpoint is on this
 * machine. Everything else is external.
 */
export function effectiveKind(provider: Provider): ProviderKind {
  return provider.kind === "local" && urlIsLocal(provider.baseUrl) ? "local" : "external";
}

export function isExternal(provider: Provider): boolean {
  return effectiveKind(provider) === "external";
}

/**
 * True when the user called it local and Karen disagrees.
 *
 * Worth surfacing rather than silently correcting: the person believed
 * something about their setup that is not true, and the setting is the only
 * place they will find that out.
 */
export function kindWasOverridden(provider: Provider): boolean {
  /* Nothing is overridden while there is no address to disagree with. A
     provider halfway through being typed should not be told its blank URL is
     not on this machine. */
  if (!provider.baseUrl.trim()) return false;
  return provider.kind === "local" && !urlIsLocal(provider.baseUrl);
}

/* ------------------------------------------------- naming a chosen model -- */

/**
 * The separator between a provider and a model.
 *
 * Two colons, because model ids contain single ones all the time —
 * "qwen2.5:7b" from an Ollama-style registry, "org:model" from others. A
 * separator that appears inside the thing it separates is not a separator.
 */
export const QUALIFIER = "::";

/** How a chosen model is stored: provider-qualified, so routing is unambiguous. */
export function qualify(providerId: string, model: string): string {
  return `${providerId}${QUALIFIER}${model}`;
}

export interface ModelRef {
  /** Empty for a bare model name, which means the built-in local runtime. */
  providerId: string;
  model: string;
}

/**
 * Split a stored model choice.
 *
 * A bare name has no provider and means the managed local runtime — which is
 * every model choice made before providers existed, so this is also the
 * migration: nothing stored needs rewriting.
 */
export function parseModelRef(stored: string): ModelRef {
  const at = stored.indexOf(QUALIFIER);
  if (at <= 0) return { providerId: "", model: stored };
  return { providerId: stored.slice(0, at), model: stored.slice(at + QUALIFIER.length) };
}

export function providerFor(providers: Provider[], stored: string): Provider | undefined {
  const { providerId } = parseModelRef(stored);
  if (!providerId) return undefined;
  return providers.find((p) => p.id === providerId);
}

/**
 * Whether choosing this model sends the conversation off the machine.
 *
 * The question the warning beside the model picker answers. A provider that has
 * been deleted or disabled since the choice was made is NOT assumed safe: the
 * honest answer about a model Karen cannot account for is that it does not know
 * where it goes, and the caller treats that as external.
 */
export function choiceIsExternal(providers: Provider[], stored: string): boolean {
  const { providerId } = parseModelRef(stored);
  if (!providerId) return false;
  const provider = providers.find((p) => p.id === providerId);
  return provider ? isExternal(provider) : true;
}

/* ------------------------------------------------------------ storage --- */

const str = (v: unknown, max = 200): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

/** Secret name for a provider's key. Namespaced so it cannot collide. */
export function providerSecret(id: string): `provider:${string}` {
  return `provider:${id}`;
}

/**
 * Read one provider back, rebuilt field by field.
 *
 * Same rule as the research config: a settings file is a thing a person can
 * edit, so nothing is spread through. A provider missing an id or a base URL
 * cannot be routed to and is dropped rather than half-loaded.
 */
export function parseProvider(raw: unknown): Provider | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Record<string, unknown>;
  const id = str(row["id"], 64);
  const baseUrl = str(row["baseUrl"], 500);
  /* An id is required; a base URL is NOT.
     A provider is created by a button and then filled in, so it exists for a
     moment with nothing but an id -- and requiring a URL here meant the save
     that follows the button silently discarded it. "Add a provider" did
     nothing at all, which is how this was found. Routing refuses a provider
     with no URL separately, where it can say so. */
  if (!id) return undefined;
  return {
    id,
    label: str(row["label"]),
    // Anything that is not the word "local" is external, so a corrupt or
    // missing value fails to the cautious side rather than the convenient one.
    kind: row["kind"] === "local" ? "local" : "external",
    baseUrl,
    models: Array.isArray(row["models"])
      ? [...new Set(row["models"].map((m) => str(m, 200)).filter(Boolean))]
      : [],
    enabled: row["enabled"] !== false,
  };
}

export function parseProviders(raw: unknown): Provider[] {
  if (!Array.isArray(raw)) return [];
  const out: Provider[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const provider = parseProvider(entry);
    // A duplicate id would make routing depend on array order.
    if (!provider || seen.has(provider.id)) continue;
    seen.add(provider.id);
    out.push(provider);
  }
  return out;
}

/** Whether this provider can actually be sent a request. */
export function isUsable(provider: Provider): boolean {
  return provider.enabled && provider.baseUrl.trim().length > 0;
}

/**
 * An id that has never been used before, and will not be used again.
 *
 * This was `p1`, `p2`, … counting up past whatever was in the list, and that is
 * a credential bug rather than an aesthetic one. A provider's API key is stored
 * under `provider:<id>`. Delete the provider you had for one vendor, add
 * another for a different vendor, and the counter hands out the same id again —
 * so the new provider inherits the old one's key and Karen sends one company's
 * credential to another company. Nothing on screen would show it, because the
 * key is write-only from the interface.
 *
 * The stored key is deleted when a provider is removed, which closes the same
 * hole from the other side. Both, because one of them is somewhere a future
 * code path could forget to call.
 *
 * Random rather than a high-water mark: there is nowhere to keep a high-water
 * mark that survives a settings file being edited or restored from a backup,
 * and 60 bits of randomness will not repeat.
 */
export function newProviderId(existing: Provider[]): string {
  const taken = new Set(existing.map((p) => p.id));
  for (let attempt = 0; attempt < 100; attempt++) {
    const bytes = new Uint8Array(8);
    globalThis.crypto.getRandomValues(bytes);
    const id = `p${[...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 12)}`;
    if (!taken.has(id)) return id;
  }
  /* Unreachable short of a broken RNG, and a duplicate id is exactly the case
     that must not be quietly produced -- it is the one that leaks a key. */
  throw new Error("Could not allocate a provider id.");
}

/**
 * Provider keys that no provider claims any more.
 *
 * Returned as secret names so the caller can forget them. An API key that
 * outlives the provider it belonged to is a credential kept on disk that the
 * person believes they deleted, and it is also what a reused id would hand to
 * the wrong endpoint.
 */
export function orphanedSecrets(before: Provider[], after: Provider[]): string[] {
  const kept = new Set(after.map((p) => p.id));
  return before.filter((p) => !kept.has(p.id)).map((p) => providerSecret(p.id));
}
