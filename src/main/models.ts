/**
 * One resolver, and one lister, for every model that is not the chat model.
 *
 * Transcription, voice and image generation all ask the same two questions --
 * "which model did the user choose for this job, and where do I send it" and
 * "what could they choose" -- and the answer has to be the same shape each
 * time. This is that shape. It was lifted out of main/audio.ts when image
 * generation became the third caller, because the alternative was a second
 * copy of the routing rules, and routing is where a copy that drifts is a
 * privacy bug rather than an inconsistency: `external` here is what the picker
 * warns on and what the privacy report counts.
 *
 * The rule that matters most is negative. A reference naming a provider that
 * has since been deleted is an ERROR, never a quiet fallback to something
 * local -- falling back would send a recording, or a prompt, somewhere the user
 * did not choose.
 */

import type { ConfigStore, EndpointSettings } from "../core/config.ts";
import { isForRole, modelIdOf, type MediaRole, type ModelOption } from "../core/models/roles.ts";
import {
  isExternal, isUsable, parseModelRef, providerFor, providerSecret, qualify,
} from "../core/providers.ts";
import { enabledOnly } from "../core/runtime/catalog.ts";
import type { SecretVault } from "./secrets.ts";
import type { RuntimeManager } from "./runtime/manager.ts";

export interface MediaDeps {
  config: ConfigStore;
  vault: SecretVault;
  runtime: RuntimeManager;
  send: (channel: string, payload?: unknown) => void;
}

export interface ResolvedModel {
  endpoint: EndpointSettings;
  apiKey?: string | undefined;
  /** True when using this sends what you give it off the machine. */
  external: boolean;
  /** For a message that can name what it is talking about. */
  label: string;
}

/**
 * The words each role uses about itself.
 *
 * A table rather than three branches, because these appear in error messages a
 * user reads at the moment something did not work, and "the voice model cannot
 * speak" has to come out of the same machinery as "the image model cannot
 * draw" without either being a special case.
 */
interface RoleWords {
  /** "transcription", for "No X model is chosen". */
  noun: string;
  /** Where to go and fix it. */
  where: string;
  /** The verb it cannot do without the engine. */
  cannot: string;
}

export const ROLE_WORDS: Record<MediaRole, RoleWords> = {
  transcription: { noun: "transcription", where: "Settings → Audio", cannot: "listen" },
  voice: { noun: "voice", where: "Settings → Audio", cannot: "speak" },
  image: { noun: "image", where: "the picker above", cannot: "draw" },
};

/**
 * Turn a stored choice into something that can be called.
 *
 * Throws rather than returning undefined, because every caller has a person
 * waiting on the other end of it: silence with no explanation is the failure
 * mode this replaces, where dictation with no endpoint configured recorded
 * happily and then produced nothing.
 */
export async function resolveMediaModel(
  deps: Pick<MediaDeps, "config" | "vault" | "runtime">,
  role: MediaRole,
  ref: string,
  { start = false }: { start?: boolean } = {},
): Promise<ResolvedModel> {
  const settings = deps.config.current;
  const words = ROLE_WORDS[role];

  if (!ref.trim()) {
    throw new Error(`No ${words.noun} model is chosen. Pick one in ${words.where}.`);
  }

  const { providerId } = parseModelRef(ref);
  const model = modelIdOf(ref);

  if (providerId) {
    const provider = providerFor(settings.providers, ref);
    if (!provider) {
      throw new Error(
        `The ${words.noun} model came from a provider that no longer exists. ` +
          `Choose another in ${words.where}.`,
      );
    }
    if (!isUsable(provider)) {
      throw new Error(
        `${provider.label || "That provider"} is switched off or has no address, so the ` +
          `${words.noun} model cannot be reached. Check Settings → Providers.`,
      );
    }
    const apiKey = await deps.vault.get(providerSecret(provider.id));
    return {
      /* Built rather than spread from another endpoint, for the reason
         `resolveLlm` gives: `envVar` names where some other endpoint's key
         comes from, and carrying it onto a provider it has nothing to do with
         is exactly the sort of wrong field that is inert until something
         reads it. */
      endpoint: { baseUrl: provider.baseUrl, model, envVar: "", timeoutMs: 120_000 },
      ...(apiKey ? { apiKey } : {}),
      external: isExternal(provider),
      label: `${model} (${provider.label || "provider"})`,
    };
  }

  const local = await deps.runtime.auxEndpoint(model, { start });
  if (!local) {
    throw new Error(
      `The local engine is not running, so ${model} cannot ${words.cannot}. ` +
        "Open the model picker to start it.",
    );
  }
  return {
    endpoint: { baseUrl: local.baseUrl, model: local.model, envVar: "", timeoutMs: 120_000 },
    apiKey: local.apiKey,
    external: false,
    label: model,
  };
}

/**
 * Everything that could be chosen for a role, in the order it should be shown.
 *
 * Three sources, and the order is the recommendation: what is already loaded,
 * then what is downloaded, then what could be downloaded, then the providers.
 * A catalogue entry carries its size because the difference between Whisper
 * Tiny and Whisper Large-v3 is 75 MB against 3.1 GB, and that is the whole of
 * the decision for most people.
 */
export async function modelOptions(
  deps: Pick<MediaDeps, "config" | "runtime">,
  role: MediaRole,
): Promise<ModelOption[]> {
  const out: ModelOption[] = [];
  const seen = new Set<string>();

  const loaded = new Set(deps.runtime.lemonade.status.health?.loaded ?? []);

  /* Only asked of a daemon that is already up. Listing what could be chosen is
     not worth starting an inference engine for, and the pane says so instead. */
  const installed = deps.runtime.lemonade.status.state === "ready"
    ? await deps.runtime.installedModels().catch(() => [])
    : [];

  for (const model of installed) {
    if (!isForRole(model.labels, role)) continue;
    seen.add(model.id);
    out.push({
      ref: model.id,
      model: model.id,
      where: "local",
      external: false,
      downloaded: model.downloaded !== false,
      loaded: loaded.has(model.id),
      ...(model.sizeBytes !== undefined ? { sizeBytes: model.sizeBytes } : {}),
    });
  }

  /* The catalogue needs no daemon: it is a file inside the install, which is
     what lets the pane offer a first speech model on a machine where nothing
     has been downloaded and nothing is running yet. */
  for (const entry of enabledOnly(await deps.runtime.catalog().catch(() => []))) {
    if (!isForRole(entry.labels, role) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push({
      ref: entry.id,
      model: entry.id,
      where: "local",
      external: false,
      downloaded: false,
      ...(entry.sizeBytes !== undefined ? { sizeBytes: entry.sizeBytes } : {}),
    });
  }

  for (const provider of deps.config.current.providers) {
    if (!provider.enabled || !provider.baseUrl.trim()) continue;
    for (const model of provider.models) {
      out.push({
        /* `qualify`, not a slash. A reference is split back apart with
           parseModelRef, which knows only `::` -- so a ref built with a slash
           parsed as a bare id, fell through to the local branch, and asked the
           daemon for a model called `p3/whisper-1`. The chat picker always used
           qualify(); this is the one place that had its own idea. */
        ref: qualify(provider.id, model),
        model,
        where: "provider",
        providerLabel: provider.label || provider.baseUrl,
        external: isExternal(provider),
      });
    }
  }

  return out;
}
