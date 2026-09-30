/**
 * What the tuning panel makes of speculative decoding, for one model.
 *
 * Split out of the component for the reason everything decidable lives in
 * `core/`: the rules here -- which flags to offer, and what to say under them --
 * are the ones a wrong `===` turns into an offered setting that stops a model
 * loading, and a component has no test. The inputs are two findings the caller
 * has already gathered, so nothing here knows where a layer count comes from.
 *
 * The findings are kept apart on purpose. The file's own header says whether it
 * carries MTP layers; Lemonade's `mtp` label says it will switch them on -- and
 * is the only evidence for a Gemma-4 MTP model, whose head is a separate draft
 * file that its own weights say nothing of.
 */

import type { FlagSpec } from "./llamaArgs.ts";

export interface MtpFacts {
  /** Layers in the model's own file: `0` was read and is none, absent was not read. */
  mtpLayers?: number | undefined;
  /** Lemonade labels the model `mtp`, and adds `--spec-type draft-mtp` itself. */
  lemonadeMtp?: boolean | undefined;
}

/**
 * `"no"` is a finding -- the header was read and names none -- and `"unknown"`
 * is the absence of one. They are kept apart for the same reason the reasoning
 * control keeps `none` and `unchecked` apart: printing the first for the second
 * would be MyRA asserting a fact about a model that it does not have.
 */
export type MtpSupport = "yes" | "no" | "unknown";

export function mtpSupport(facts: MtpFacts): MtpSupport {
  if (facts.lemonadeMtp || (facts.mtpLayers ?? 0) > 0) return "yes";
  return facts.mtpLayers === 0 ? "no" : "unknown";
}

/**
 * Whether a flag belongs in the default list, before its own `advanced` flag is
 * asked. A model not known to have MTP keeps these behind "Every flag MyRA
 * knows" rather than losing them: a wrong guess should cost a click, not remove
 * a setting somebody needs.
 */
export function gatedOut(spec: FlagSpec, facts: MtpFacts): boolean {
  return spec.gate === "mtp" && mtpSupport(facts) !== "yes";
}

/**
 * Whether draft-mtp will be on when the model launches.
 *
 * No `--spec-type` written means Lemonade's own default applies, which is on for
 * a model it labels `mtp`; any `--spec-type` at all replaces that default --
 * `append_runtime_arg_defaults` skips a default whose flag the arguments carry,
 * `none` included -- which is how it is turned off. The list form is one
 * llama.cpp accepts (`ngram-mod,draft-mtp`), so it is split rather than compared.
 */
export function draftMtpOn(values: Record<string, string>, facts: MtpFacts): boolean {
  const type = values["--spec-type"];
  return type !== undefined ? type.split(",").includes("draft-mtp") : facts.lemonadeMtp === true;
}

export interface SpeculativeNote {
  text: string;
  /** Shown in red: this one stops the model loading. */
  bad: boolean;
}

/** What to say under a flag that depends on the model or on another flag. */
export function speculativeNote(
  spec: FlagSpec,
  values: Record<string, string>,
  facts: MtpFacts,
): SpeculativeNote | undefined {
  const on = draftMtpOn(values, facts);
  if (spec.flag === "--spec-type") {
    /* Only an explicit value can land here with support `"no"`: a model
       Lemonade labels `mtp` is `"yes"` whatever its own weights say. */
    if (mtpSupport(facts) === "no" && on) {
      return {
        bad: true,
        text: "This model's file has no MTP layers, so llama-server will refuse to load it with this on.",
      };
    }
    if (values["--spec-type"] === undefined && facts.lemonadeMtp) {
      return {
        bad: false,
        text:
          "Lemonade already turns draft-mtp on for this model. Leave this unset to keep that, " +
          "or choose none to turn it off.",
      };
    }
    return undefined;
  }
  if (spec.gate === "mtp" && !on) {
    return { bad: false, text: "Does nothing until speculative decoding above is on." };
  }
  return undefined;
}
