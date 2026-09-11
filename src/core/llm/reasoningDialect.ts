/**
 * How each endpoint spells "think harder", in its own words.
 *
 * There is no common parameter for this and no prospect of one. Four vendors
 * have four shapes -- `reasoning_effort`, an OpenRouter `reasoning` object, a
 * Google thinking budget in tokens, an Anthropic budget in tokens -- and local
 * models have a fifth, where the switch is not an API field at all but a
 * variable inside the model's own chat template.
 *
 * MyRA does not translate between them. A single Off/Brief/Deep vocabulary
 * would have to claim that OpenAI's "low" and a 1024-token Gemini budget are
 * the same thing, and they are not; worse, it would put MyRA's words in front
 * of a parameter the user may need to talk about with a colleague or a
 * sysadmin. So the control shows the field name and the values that endpoint
 * actually takes, and this module is the list of what those are.
 *
 * **Two of these are measured and three are read from documentation**, which
 * is why nothing here is sent speculatively. Against the local stack:
 *
 *   - llama.cpp answers 200 to a request carrying `myra_nonsense_param`.
 *     Acceptance proves nothing at all, so "it did not error" can never be
 *     the evidence that a switch works.
 *   - `chat_template_kwargs` genuinely reaches the template: rendering the
 *     same messages through `/apply-template` with `preserve_thinking` set
 *     changed the prompt, and with an unknown key did not.
 *
 * The hosted shapes come from each vendor's API reference and have not been
 * measured here. `verifiedDialect` is what keeps that honest: a hosted control
 * is offered only once a probe against that endpoint has come back clean,
 * because a strict server rejects the whole request over one unknown field and
 * a chat that 400s is far worse than a chat that does not show its workings.
 */

/** One value the control can send, named as the endpoint names it. */
export interface ReasoningLevel {
  /** Exactly what goes on the wire. */
  value: string;
  /** What the endpoint calls it. Never MyRA's own word for it. */
  label: string;
  /** Plain language, for the tooltip, where a translation belongs. */
  hint: string;
}

export interface ReasoningDialect {
  id: string;
  /** The request field, shown as the control's label. */
  param: string;
  /** Who defines this spelling, so the tooltip can attribute it. */
  source: string;
  levels: ReasoningLevel[];
  /**
   * The level MyRA sends when the user has not chosen one.
   *
   * Only ever set where sending the field is free and known-safe, which today
   * means a local template variable MyRA has watched change that model's own
   * rendered prompt. A hosted dialect never carries one: an effort nobody
   * asked for is billed to somebody's account, and on a strict gateway it is
   * the unknown parameter that fails the whole request.
   */
  preferred?: string | undefined;
  /**
   * Whether MyRA has seen this work, as opposed to read that it should.
   *
   * `measured` dialects are discovered by rendering the model's own template
   * and observing the prompt change. `documented` ones need a probe against
   * the endpoint before the control appears.
   */
  evidence: "measured" | "documented";
}

/* -------------------------------------------------------------- hosted -- */

const OPENAI: ReasoningDialect = {
  id: "openai-effort",
  param: "reasoning_effort",
  source: "OpenAI",
  evidence: "documented",
  levels: [
    { value: "minimal", label: "minimal", hint: "Answer with as little reasoning as the model can manage." },
    { value: "low", label: "low", hint: "A little reasoning before answering." },
    { value: "medium", label: "medium", hint: "The model's own default." },
    { value: "high", label: "high", hint: "Reason at length. Slower, and more output tokens to pay for." },
  ],
};

/**
 * OpenRouter takes an object, and is the only one with an explicit off.
 *
 * `{ enabled: false }` rather than an effort of "none": the field is
 * documented as a switch with an effort inside it, and sending an effort value
 * the vendor does not define is how a working chat becomes a 400.
 */
const OPENROUTER: ReasoningDialect = {
  id: "openrouter-reasoning",
  param: "reasoning",
  source: "OpenRouter",
  evidence: "documented",
  levels: [
    { value: "off", label: "enabled: false", hint: "Ask the upstream model not to reason." },
    { value: "low", label: "effort: low", hint: "A little reasoning before answering." },
    { value: "medium", label: "effort: medium", hint: "OpenRouter's middle setting." },
    { value: "high", label: "effort: high", hint: "Reason at length. Slower, and more tokens to pay for." },
  ],
};

/**
 * Google counts in tokens, and its two special values are not sizes.
 *
 * `0` switches thinking off where the model allows it; `-1` hands the budget
 * back to the model. Both are Google's own numbers and are shown as such --
 * calling -1 "automatic" in the control would be MyRA inventing a word for a
 * value somebody may need to look up.
 */
const GOOGLE: ReasoningDialect = {
  id: "google-budget",
  param: "thinking_budget",
  source: "Google",
  evidence: "documented",
  levels: [
    { value: "0", label: "0", hint: "No thinking budget. Models that require thinking ignore this." },
    { value: "-1", label: "-1", hint: "The model decides its own budget." },
    { value: "8192", label: "8192", hint: "Up to 8,192 tokens of thinking." },
    { value: "24576", label: "24576", hint: "Up to 24,576 tokens of thinking. Slow, and billed." },
  ],
};

const ANTHROPIC: ReasoningDialect = {
  id: "anthropic-thinking",
  param: "thinking",
  source: "Anthropic",
  evidence: "documented",
  levels: [
    { value: "off", label: "disabled", hint: "Answer without extended thinking." },
    { value: "4096", label: "4096 tokens", hint: "Up to 4,096 tokens of extended thinking." },
    { value: "16384", label: "16384 tokens", hint: "Up to 16,384 tokens of extended thinking." },
  ],
};

/**
 * Which vendor's shape an endpoint speaks, by the host it answers on.
 *
 * Host rather than model name: the field belongs to the API, not to the
 * weights, and the same model reached through two gateways takes two different
 * fields. Returns nothing for an unrecognised host, which is the common case
 * and the safe one -- an unknown endpoint gets no control rather than a guess
 * that could 400 its next chat.
 */
export function dialectForHost(baseUrl: string): ReasoningDialect | undefined {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return DIALECTS.find((d) => d.hosts.some((h) => host === h || host.endsWith(`.${h}`)))?.dialect;
}

/**
 * Every shape MyRA knows, with the hosts that speak each.
 *
 * Hostnames, deliberately not URLs. Nothing here is ever fetched -- these are
 * lookup keys for a request MyRA builds against an address the user typed --
 * and writing them as `https://…` literals would put four vendor endpoints
 * into the source that the privacy report scans for reachable hosts. It found
 * them, correctly, the first time this was written the other way.
 */
const DIALECTS: { hosts: string[]; dialect: ReasoningDialect }[] = [
  { hosts: ["api.openai.com"], dialect: OPENAI },
  { hosts: ["openrouter.ai"], dialect: OPENROUTER },
  { hosts: ["api.anthropic.com"], dialect: ANTHROPIC },
  { hosts: ["generativelanguage.googleapis.com"], dialect: GOOGLE },
];

/** The dialect a stored choice belongs to, by the id it was stored under. */
export function dialectById(id: string): ReasoningDialect | undefined {
  if (id.startsWith("template:")) return templateDialect(id.slice("template:".length));
  return DIALECTS.find((d) => d.dialect.id === id)?.dialect;
}

/* --------------------------------------------------------------- local -- */

/**
 * Template variables that mean "should you think", and only those.
 *
 * An allowlist, not "any variable that changes the prompt", and LFM2.5 is why.
 * Its template reads `preserve_thinking`, which does change the rendered
 * prompt -- measured -- but what it changes is whether EARLIER assistant turns
 * keep their `<think>` blocks when they are replayed. It says nothing about
 * whether the model thinks now, and a control built by diffing would have
 * offered it as one.
 *
 * That same template ends every generation prompt with a literal `<think>`
 * and has no switch at all, which is the case the UI has to be able to state:
 * some models cannot be told not to think.
 */
export const THINKING_KWARGS: {
  name: string;
  values: ReasoningLevel[];
  /** Sent when the user has not chosen; see `preferred` on the dialect. */
  preferred?: string;
}[] = [
  {
    name: "enable_thinking",
    /* On unless the user turns it off. A model whose template reads this is a
       reasoning model and the reasoning is what it was chosen for, while
       sending nothing hands the decision to whatever that particular template
       happens to default to -- which differs between models that spell the
       switch identically, so "I did not touch it" produced thinking on one
       model and none on the next. */
    preferred: "true",
    values: [
      { value: "false", label: "false", hint: "Ask the template to skip the thinking block." },
      { value: "true", label: "true", hint: "Let the model think before answering." },
    ],
  },
  {
    name: "reasoning_effort",
    values: [
      { value: "low", label: "low", hint: "A little reasoning before answering." },
      { value: "medium", label: "medium", hint: "The template's middle setting." },
      { value: "high", label: "high", hint: "Reason at length before answering." },
    ],
  },
  {
    name: "reasoning_strength",
    values: [
      { value: "low", label: "low", hint: "A little reasoning before answering." },
      { value: "medium", label: "medium", hint: "The template's middle setting." },
      { value: "high", label: "high", hint: "Reason at length before answering." },
      { value: "xhigh", label: "xhigh", hint: "Reason as hard as the template allows. Slowest, most output tokens." },
    ],
  },
];

/**
 * The dialect for a local model whose template was found to read `name`.
 *
 * `measured`, because the only way this is ever constructed is by rendering
 * the model's own template twice and seeing the prompt change.
 */
export function templateDialect(name: string): ReasoningDialect | undefined {
  const known = THINKING_KWARGS.find((k) => k.name === name);
  if (!known) return undefined;
  return {
    id: `template:${name}`,
    param: name,
    source: "this model's chat template",
    evidence: "measured",
    levels: known.values,
    ...(known.preferred ? { preferred: known.preferred } : {}),
  };
}

/* ------------------------------------------------------- what to send -- */

/**
 * The request fields for one choice, ready to merge into `extra`.
 *
 * Returns an empty object for a value the dialect does not list, rather than
 * passing it through: the values are the endpoint's, and one MyRA invented
 * would be the unknown parameter that breaks the request.
 */
export function reasoningFields(
  dialect: ReasoningDialect,
  value: string,
): Record<string, unknown> {
  if (!dialect.levels.some((l) => l.value === value)) return {};
  if (dialect.id === "openai-effort") return { reasoning_effort: value };
  if (dialect.id === "openrouter-reasoning") {
    return value === "off"
      ? { reasoning: { enabled: false } }
      : { reasoning: { effort: value } };
  }
  if (dialect.id === "google-budget") {
    return { google: { thinking_config: { thinking_budget: Number(value) } } };
  }
  if (dialect.id === "anthropic-thinking") {
    return value === "off"
      ? { thinking: { type: "disabled" } }
      : { thinking: { type: "enabled", budget_tokens: Number(value) } };
  }
  if (dialect.id.startsWith("template:")) {
    const name = dialect.id.slice("template:".length);
    /* Booleans as booleans. A template testing `if enable_thinking` treats the
       STRING "false" as true, so sending the user's choice verbatim would turn
       thinking off by turning it on. */
    const raw: unknown = value === "true" ? true : value === "false" ? false : value;
    return { chat_template_kwargs: { [name]: raw } };
  }
  return {};
}

/**
 * The level in force for a dialect, given whatever the user stored.
 *
 * One function so the control and the request cannot disagree. They did while
 * the default lived in two places: the composer drew `enable_thinking` as
 * unset while every request carried `true`, so the button showing what was
 * being sent was the one that was not lit.
 *
 * A stored value the dialect does not list falls back to the preferred level
 * rather than through: values are the endpoint's vocabulary, and one left over
 * from a different dialect is not a level here whatever it reads as.
 */
export function effectiveLevel(dialect: ReasoningDialect, stored: string | undefined): string {
  if (stored && dialect.levels.some((l) => l.value === stored)) return stored;
  return dialect.preferred ?? "";
}

/**
 * Several dialects' fields as one request body fragment.
 *
 * A plain spread is wrong here and quietly so: two template switches each
 * return a `chat_template_kwargs` object, and the second would replace the
 * first -- so a model told `reasoning_effort: high` would silently stop being
 * told `enable_thinking: true`. That one key is merged; everything else is a
 * distinct top-level field belonging to a distinct vendor, and those cannot
 * collide because no endpoint speaks two of these dialects.
 */
export function mergeReasoningFields(
  parts: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const kwargs: Record<string, unknown> = {};
  for (const part of parts) {
    for (const [key, value] of Object.entries(part)) {
      if (key === "chat_template_kwargs" && value && typeof value === "object") {
        Object.assign(kwargs, value as Record<string, unknown>);
      } else {
        out[key] = value;
      }
    }
  }
  if (Object.keys(kwargs).length) out["chat_template_kwargs"] = kwargs;
  return out;
}
