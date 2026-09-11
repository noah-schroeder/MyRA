/**
 * What the model in front of the user can be told about thinking.
 *
 * Two very different kinds of evidence, kept apart on purpose.
 *
 * **Local models are read, not guessed.** The loaded llama-server renders its
 * own chat template on `/apply-template`, so MyRA asks it to render the same
 * messages with and without each known switch and compares the prompts. A
 * difference means the template reads that variable; identical prompts mean it
 * does not, whatever the API accepted -- and llama.cpp accepts everything,
 * including fields that do not exist.
 *
 * **Hosted endpoints cannot be read**, only asked, and asking costs money and
 * can fail the request. So a hosted control appears only after the reasoning
 * check in Settings → Providers has sent one probe carrying the field and had
 * it come back clean. Until then there is no control, which is the same rule
 * `askReasoning` already follows and for the same reason: a strict server
 * rejects a whole request over one unknown parameter.
 *
 * The result is cached per model. Rendering a template is cheap but not free,
 * and the answer cannot change while a model stays loaded -- it is a property
 * of the weights' own template.
 */

import { dialectForHost, type ReasoningDialect } from "../../core/llm/reasoningDialect.ts";
import {
  alwaysThinks, applyTemplateUrl, findTemplateSwitches, PROBE_MESSAGES,
} from "../../core/llm/templateProbe.ts";
import type { LoadedModel } from "../../core/runtime/lemonade.ts";
import type { Provider } from "../../core/providers.ts";

/**
 * Why there is no control, in a form the UI can branch on.
 *
 * The distinction is not decoration. `none` and `always` are findings -- MyRA
 * asked the model and this is the answer -- while `unchecked` and `unknown`
 * mean nothing has been established. Printing "no thinking setting" for the
 * second pair would be MyRA asserting a fact it does not have, which is the
 * one thing this app is not allowed to do about models.
 */
export type NoControl =
  /** Asked, and this model's template reads no thinking switch. */
  | "none"
  /** Asked, and it thinks on every turn with no way to stop it. */
  | "always"
  /** Could be checked, has not been: no model loaded, or no probe run yet. */
  | "unchecked"
  /** Cannot be established from here at all. */
  | "unknown";

export interface ReasoningCapability {
  /**
   * The controls to draw, in the order they should appear.
   *
   * A list because a model can answer two questions at once: a Qwen3 template
   * reads `enable_thinking` and `reasoning_effort` both, and reporting one
   * dialect meant the effort control never appeared on the models that have
   * one. Empty is the ordinary "nothing to draw" case, and `reason` says why.
   */
  dialects: ReasoningDialect[];
  reason?: NoControl | undefined;
  /**
   * Why there is no control, when there is none.
   *
   * Said rather than left blank: "this model has no setting for that" and
   * "MyRA has not checked yet" look identical as an absence, and only one of
   * them is something the user can act on.
   */
  note?: string | undefined;
}

/** Answers keyed by model, because the template belongs to the weights. */
const cache = new Map<string, ReasoningCapability>();

export function forgetReasoning(model?: string): void {
  if (model) cache.delete(model);
  else cache.clear();
}

async function renderWith(
  url: string,
  body: Record<string, unknown>,
): Promise<string | undefined> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const parsed = (await res.json()) as { prompt?: unknown };
    return typeof parsed.prompt === "string" ? parsed.prompt : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The switch a loaded local model understands, by rendering its template.
 *
 * `undefined` from the render is carried through as "could not ask", which is
 * reported differently from "asked, and it reads nothing".
 */
export async function localCapability(loaded: LoadedModel): Promise<ReasoningCapability> {
  const cached = cache.get(loaded.id);
  if (cached) return cached;

  const url = loaded.backendUrl ? applyTemplateUrl(loaded.backendUrl) : undefined;
  if (!url) {
    return {
      dialects: [],
      reason: "unknown",
      note: "MyRA cannot see this model's template, so it cannot say what it accepts.",
    };
  }

  const baseline = await renderWith(url, { messages: PROBE_MESSAGES });
  if (baseline === undefined) {
    /* Not cached. The server may simply not be up yet, and remembering "no"
       from a moment when nothing could answer would outlive the reason. */
    return {
      dialects: [],
      reason: "unchecked",
      note: "The model's engine did not answer, so this could not be checked.",
    };
  }

  const dialects = await findTemplateSwitches((body) => renderWith(url, body));
  const answer: ReasoningCapability = dialects.length
    ? { dialects }
    : alwaysThinks(baseline)
      ? {
          dialects: [],
          reason: "always",
          note: "This model thinks on every turn and its template has no setting to stop it.",
        }
      : {
          dialects: [],
          reason: "none",
          note: "This model's template has no setting for thinking.",
        };
  cache.set(loaded.id, answer);
  return answer;
}

/**
 * The switch a hosted provider takes, once it has been checked.
 *
 * The check is the gate, not the vendor's documentation. MyRA knows what
 * OpenAI's field is called; what it does not know until it has asked is
 * whether THIS endpoint -- which may be a proxy, a gateway, or an older
 * deployment -- will accept it.
 */
export function hostedCapability(provider: Provider): ReasoningCapability {
  const dialect = dialectForHost(provider.baseUrl);
  if (!dialect) {
    return {
      dialects: [],
      reason: "unknown",
      note: "MyRA does not know what this endpoint calls its thinking setting.",
    };
  }
  if (provider.reasoningParam !== dialect.id) {
    return {
      dialects: [],
      reason: "unchecked",
      note:
        `${provider.label} documents a “${dialect.param}” setting. MyRA has not checked that ` +
        "this endpoint accepts it — run the reasoning check in Settings → Providers, and the " +
        "control appears here if it does.",
    };
  }
  return { dialects: [dialect] };
}

/**
 * What the last check found for a local model, without asking again.
 *
 * Synchronous on purpose: this is read while a chat request is being built,
 * and a request is not the place to start rendering templates. Nothing is
 * lost by it being empty -- the control that sets a choice is only drawn after
 * `localCapability` has answered, so a choice cannot exist for a model whose
 * capability was never cached.
 */
export function cachedLocalDialects(model: string): ReasoningDialect[] {
  return cache.get(model)?.dialects ?? [];
}
