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
import { parseJsonReply, runSubagent, type SubagentUsage } from "./subagent.ts";
import type { ResolvedRoles } from "./roles.ts";
import type { Scope } from "./scope.ts";

export interface Plan {
  scope: Scope;
  /** SearXNG categories the sweep runs against, comma-separated. */
  category: string;
  /** Query variants, generated but yours to edit. */
  queries: string[];
  /** Result pages to request per query. */
  pages: number;
  /** How many candidates survive the embedding rank and go to the screener. */
  screenTop: number;
  /** How many screened-in papers are read in full. */
  fullTexts: number;
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
    ``,
    `## Models`,
    `screener: ${plan.roles.screener}`,
    `analyst: ${plan.roles.analyst}`,
    `synthesist: ${plan.roles.synthesist}`,
    `reviewer: ${plan.roles.reviewer}`,
    `embedder: ${plan.embedModel ?? "(none — screening will use the model only)"}`,
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

  const roleOf = (role: keyof ResolvedRoles): string => {
    const value = models.get(role) ?? previous.roles[role];
    if (!value.includes("/")) {
      throw new PlanError(
        `${role}: "${value}" is not a model — use provider/id, e.g. ${previous.roles[role]}`,
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
