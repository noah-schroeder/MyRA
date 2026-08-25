/**
 * The plan: everything the run will do, as text you can edit.
 *
 * One dialog, not six approval prompts. You see the scope, the criteria, the
 * generated queries, every cap and every model assignment, you change whatever
 * is wrong, and you approve once. Nothing expensive has run at this point --
 * that is the whole reason the plan comes before discovery rather than after.
 *
 * The format is markdown because you read it, but it is parsed strictly enough
 * to catch a typo'd model rather than discovering it forty minutes in.
 */

import { parseCategories } from "./config.ts";
import { parseJsonReply, runSubagent, type SubagentUsage } from "../llm/chat.ts";
import { reviewerIsSynthesist, type ResolvedRoles } from "./roles.ts";
import type { Scope } from "./scope.ts";

export interface Plan {
  scope: Scope;
  /** Where the sweep searches: "science" or "general", comma-separated. */
  category: string;
  /** Query variants, generated but yours to edit. */
  queries: string[];
  /** Result pages to request per query. */
  pages: number;
  /** How many candidates survive the embedding rank and go to the screener. */
  screenTop: number;
  /** How many screened-in papers are read in full. */
  fullTexts: number;
  /**
   * Rounds of backward citation-graph traversal ("snowballing"). 0 is off.
   *
   * Each round takes the papers screening kept, collects what they cite, and
   * puts the works cited by SEVERAL of them through screening as well. That
   * co-citation filter is the point: it surfaces the paper everyone in a
   * literature builds on, which keyword search reliably misses because its
   * title uses the vocabulary of thirty years ago.
   */
  snowball: number;
  roles: ResolvedRoles;
  embedModel?: string;
}

const list = (items: string[]): string =>
  items.length ? items.map((i) => `- ${i}`).join("\n") : "- (none)";

export function renderPlan(plan: Plan): string {
  return [
    `# Research plan`,
    ``,
    `Edit anything below, then save. Nothing has run yet.`,
    ``,
    `## Question`,
    plan.scope.question,
    ``,
    `## Sub-questions`,
    list(plan.scope.subQuestions),
    ``,
    `## Population`,
    plan.scope.population ?? "(not specified)",
    ``,
    `## Timeframe`,
    plan.scope.timeframe ?? "(not specified)",
    ``,
    `## Include`,
    list(plan.scope.include),
    ``,
    `## Exclude`,
    list(plan.scope.exclude),
    ``,
    `## Queries`,
    list(plan.queries),
    ``,
    `## Limits`,
    `category: ${parseCategories(plan.category).join(", ")}`,
    `pages: ${plan.pages}`,
    `screen_top: ${plan.screenTop}`,
    `full_texts: ${plan.fullTexts}`,
    `snowball: ${plan.snowball ?? 0}`,
    ``,
    `## Models`,
    `screener: ${plan.roles.screener}`,
    `analyst: ${plan.roles.analyst}`,
    `synthesist: ${plan.roles.synthesist}`,
    `reviewer: ${plan.roles.reviewer}`,
    `embedder: ${plan.embedModel ?? "(none — screening will use the model only)"}`,
    ...(reviewerIsSynthesist(plan.roles)
      ? [
          ``,
          `> The reviewer and the synthesist are the same model, so the review stage`,
          `> is self-review. A model asked to critique its own draft mostly defends`,
          `> the reasoning it already committed to. Name a different reviewer above`,
          `> if you have one; the run will say it did not if you do not.`,
        ]
      : []),
    ...(plan.embedModel
      ? []
      : [
          ``,
          `> With no embeddings model, candidates cannot be ranked by meaning. The`,
          `> screener sees an even slice taken across all queries instead — set one`,
          `> in Settings → Endpoints to rank ${plan.screenTop} by relevance.`,
        ]),
    ``,
  ].join("\n");
}

/* ------------------------------------------------------------------ *
 * Parsing back                                                        *
 * ------------------------------------------------------------------ */

const PLACEHOLDER = /^\((none|not specified)[^)]*\)$/i;

function sections(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string | undefined;
  for (const raw of text.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(raw);
    if (heading) {
      current = heading[1]!.toLowerCase();
      out.set(current, []);
      continue;
    }
    if (current) out.get(current)!.push(raw);
  }
  return out;
}

function bullets(lines: string[] | undefined): string[] {
  return (lines ?? [])
    .map((l) => /^\s*[-*]\s+(.*)$/.exec(l)?.[1]?.trim() ?? "")
    .filter((v) => v && !PLACEHOLDER.test(v));
}

function paragraph(lines: string[] | undefined): string | undefined {
  const text = (lines ?? []).map((l) => l.trim()).filter(Boolean).join(" ").trim();
  return !text || PLACEHOLDER.test(text) ? undefined : text;
}

function keyValues(lines: string[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of lines ?? []) {
    const m = /^\s*([a-z_]+)\s*:\s*(.+?)\s*$/i.exec(line);
    if (m) out.set(m[1]!.toLowerCase(), m[2]!.trim());
  }
  return out;
}

export class PlanError extends Error {
  override readonly name = "PlanError";
}

function number(values: Map<string, string>, key: string, fallback: number, max: number): number {
  const raw = values.get(key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) throw new PlanError(`${key} must be a positive number, got "${raw}"`);
  return Math.min(Math.floor(n), max);
}

/** Snowball rounds, where 0 means "do not traverse" rather than "invalid". */
function rounds(values: Map<string, string>, fallback: number): number {
  const raw = values.get("snowball");
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new PlanError(`snowball must be 0 or more, got "${raw}"`);
  }
  // Each round screens a fresh batch of papers, so the cost compounds; two is
  // already a long run.
  return Math.min(Math.floor(n), 2);
}

/**
 * Parse an edited plan, and reject what cannot work.
 *
 * Strict on purpose. A model name with a typo would otherwise surface as a
 * failure deep inside screening, after the search has already run.
 */
export function parsePlan(text: string, previous: Plan, knownModels?: string[]): Plan {
  const s = sections(text);
  const question = paragraph(s.get("question"));
  if (!question) throw new PlanError("the plan has no question — the ## Question section is empty");

  const subQuestions = bullets(s.get("sub-questions"));
  if (subQuestions.length === 0) {
    throw new PlanError("the plan has no sub-questions — the sweep would search once and stop");
  }
  const queries = bullets(s.get("queries"));
  if (queries.length === 0) throw new PlanError("the plan has no queries — nothing would be searched");

  const limits = keyValues(s.get("limits"));
  const models = keyValues(s.get("models"));

  /**
   * Validate a role's model against what the server actually serves.
   *
   * v1 required "provider/id" here, because that is how pi's dropdown formatted
   * models. v2 discovers them from GET /v1/models, which returns the bare name
   * the server knows -- "qwen3-30b-a3b" -- so that rule rejected every real
   * model and failed the run at the plan step. There is nothing to infer from
   * the shape of a model id; the only useful check is whether it is one of the
   * ids we were told about.
   */
  const roleOf = (role: keyof ResolvedRoles): string => {
    const value = (models.get(role) ?? previous.roles[role]).trim();
    if (!value || PLACEHOLDER.test(value)) {
      throw new PlanError(
        `${role}: no model chosen, and no default to fall back on. Set a model in ` +
          `Settings → Endpoints, or name one in the Models section above.`,
      );
    }
    if (knownModels?.length && !knownModels.includes(value)) {
      throw new PlanError(
        `${role}: "${value}" is not a configured model. Available: ${knownModels.join(", ")}`,
      );
    }
    return value;
  };

  const embedRaw = models.get("embedder");
  const embedModel = !embedRaw || PLACEHOLDER.test(embedRaw) ? undefined : embedRaw;

  return {
    scope: {
      question,
      subQuestions,
      include: bullets(s.get("include")),
      exclude: bullets(s.get("exclude")),
      ...(paragraph(s.get("population")) ? { population: paragraph(s.get("population"))! } : {}),
      ...(paragraph(s.get("timeframe")) ? { timeframe: paragraph(s.get("timeframe"))! } : {}),
    },
    // Accepts whatever spacing the user typed when editing the plan by hand.
    category: parseCategories(limits.get("category") ?? "").join(",") || previous.category,
    queries,
    pages: number(limits, "pages", previous.pages, 10),
    screenTop: number(limits, "screen_top", previous.screenTop, 1000),
    fullTexts: number(limits, "full_texts", previous.fullTexts, 100),
    // Zero is meaningful here, unlike every other limit, so it cannot go
    // through number() -- which rejects anything below 1.
    snowball: rounds(limits, previous.snowball ?? 0),
    roles: {
      screener: roleOf("screener"),
      analyst: roleOf("analyst"),
      synthesist: roleOf("synthesist"),
      reviewer: roleOf("reviewer"),
    },
    ...(embedModel ? { embedModel } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Query generation                                                    *
 * ------------------------------------------------------------------ */


export function buildQueryPrompt(scope: Scope, count: number): string {
  return [
    `RESEARCH QUESTION`,
    scope.question,
    "",
    `SUB-QUESTIONS`,
    ...scope.subQuestions.map((q, i) => `  ${i + 1}. ${q}`),
    ...(scope.population ? ["", `POPULATION: ${scope.population}`] : []),
    ...(scope.timeframe ? [`TIMEFRAME: ${scope.timeframe}`] : []),
    "",
    `Write ${count} search queries for academic search engines.`,
    "",
    `  - Between them they should cover every sub-question.`,
    `  - Vary the vocabulary: different fields name the same construct differently,`,
    `    and a query that only uses the user's words finds only the user's corner`,
    `    of the literature.`,
    `  - Keywords, not sentences. No boolean operators, no quotes, no site: filters.`,
    `  - Each query should stand alone as something you would actually type.`,
    "",
    `Reply with JSON only: ["query one", "query two"]`,
  ].join("\n");
}

export async function generateQueries(opts: {
  scope: Scope;
  model: string;
  count?: number;
  signal?: AbortSignal;
  cwd?: string;
  onDelta?: (delta: string, kind: "text" | "thinking") => void;
}): Promise<{ queries: string[]; usage: SubagentUsage }> {
  const count = opts.count ?? 7;
  const result = await runSubagent({
    model: opts.model,
    prompt: buildQueryPrompt(opts.scope, count),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.onDelta ? { onDelta: opts.onDelta } : {}),
  });
  const raw = parseJsonReply<unknown[]>(result.text, "query generation");
  const queries = (Array.isArray(raw) ? raw : [])
    .filter((q): q is string => typeof q === "string" && q.trim().length > 2)
    .map((q) => q.trim())
    .slice(0, count);
  // Falling back to the bare question beats failing the run: a single-query
  // sweep is worse than a good one, but it still answers something.
  return { queries: queries.length ? queries : [opts.scope.question], usage: result.usage };
}
