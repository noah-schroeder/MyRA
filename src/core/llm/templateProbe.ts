/**
 * Finding out whether a local model can be told not to think.
 *
 * llama.cpp answers 200 to a request carrying any field it has never heard of
 * -- measured: `karen_nonsense_param` came back with a normal completion. So
 * the usual way of establishing support, send it and see whether it errors,
 * establishes nothing here. A control built on that evidence would appear to
 * work, send its parameter faithfully, and change nothing about the answer.
 *
 * There is a better instrument, and it costs no inference at all.
 * `POST /apply-template` renders the chat template and returns the prompt
 * string. Render the same messages twice, once with the switch and once
 * without, and compare: if the model's own template reads that variable the
 * prompt differs, and if it does not the prompt is identical. That is not
 * evidence about the API, it is evidence about the model, which is where the
 * behaviour actually lives.
 *
 * Measured against LFM2.5-2.6B on this machine:
 *
 *   preserve_thinking: true   ->  prompt changes (kwargs do reach the template)
 *   enable_thinking: false    ->  prompt identical (its template ignores it)
 *   karen_bogus: true         ->  prompt identical, no error
 *
 * and every render of that template ends `<|im_start|>assistant\n<think>`,
 * hard-coded with no variable in front of it. That model cannot be told not to
 * think, and the honest thing to do about it is say so rather than offer a
 * switch that does nothing.
 */

import { THINKING_KWARGS, templateDialect, type ReasoningDialect } from "./reasoningDialect.ts";

/** Two turns and a reply, so a template that only differs on replay still differs. */
export const PROBE_MESSAGES = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "<think>working</think>hello" },
  { role: "user", content: "again" },
];

export function applyTemplateUrl(backendUrl: string): string | undefined {
  try {
    return new URL("/apply-template", backendUrl).toString();
  } catch {
    return undefined;
  }
}

/** What one render returned, or nothing when the endpoint could not answer. */
export type RenderPrompt = (body: Record<string, unknown>) => Promise<string | undefined>;

/**
 * Every switch this model's template actually reads.
 *
 * All of them, not the first: a template that reads both `enable_thinking` and
 * `reasoning_effort` is answering two different questions -- whether to think
 * at all, and how hard -- and stopping at the first match offered the on/off
 * switch and hid the effort control on exactly the models that have one. They
 * are returned in THINKING_KWARGS order, so the coarse switch is drawn above
 * the fine one.
 *
 * Each variable stops at its own first difference. One level proving the
 * template reads the name is the whole finding; rendering the rest would be
 * three more round trips to learn nothing.
 *
 * A baseline that will not render means the answer is "unknown", not "no": an
 * endpoint that cannot be asked has told us nothing, and reporting that as an
 * absence of support would put a confident sentence in front of a failed
 * request.
 */
export async function findTemplateSwitches(render: RenderPrompt): Promise<ReasoningDialect[]> {
  const baseline = await render({ messages: PROBE_MESSAGES });
  if (baseline === undefined) return [];

  const found: ReasoningDialect[] = [];
  for (const kwarg of THINKING_KWARGS) {
    for (const level of kwarg.values) {
      const raw: unknown =
        level.value === "true" ? true : level.value === "false" ? false : level.value;
      const rendered = await render({
        messages: PROBE_MESSAGES,
        chat_template_kwargs: { [kwarg.name]: raw },
      });
      if (rendered !== undefined && rendered !== baseline) {
        const dialect = templateDialect(kwarg.name);
        if (dialect) found.push(dialect);
        break;
      }
    }
  }
  return found;
}

/**
 * Whether the template opens a thinking block whatever it is told.
 *
 * Separate from "has no switch", and worth saying separately: a model with no
 * switch might simply not reason, while one whose generation prompt ends in
 * `<think>` reasons on every single turn and cannot be stopped. The second is
 * the sentence a person needs when they are wondering why every answer is slow.
 */
export function alwaysThinks(prompt: string | undefined): boolean {
  return prompt !== undefined && /<think>\s*$/.test(prompt);
}
