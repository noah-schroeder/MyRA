/**
 * Which model does which job.
 *
 * Five roles rather than one dropdown per stage, because the stages cluster:
 * screening wants fast and cheap, synthesis wants your largest, and review
 * wants something OTHER than whatever wrote the draft. A second opinion from
 * the same model in the same context is not a second opinion.
 *
 * The assignments are saved and reused. That matters for a specific reason:
 * the plan step is where you choose them, but the plan step is itself model
 * work, so it needs a model BEFORE you have chosen one. Scoping therefore uses
 * the saved analyst, and on a first run falls back to whatever the app's model
 * dropdown is currently set to -- the model you are already talking to.
 */

import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const ROLES = ["screener", "analyst", "synthesist", "reviewer"] as const;
export type Role = (typeof ROLES)[number];

export interface RoleConfig {
  /** "provider/id" for each chat role. */
  models: Partial<Record<Role, string>>;
  /**
   * The embeddings model, kept separate because it is not a chat model and is
   * called directly rather than through a pi subprocess -- pi does not do
   * embeddings.
   */
  embedModel?: string;
}

export type ResolvedRoles = Record<Role, string>;

export function rolesPath(): string {
  return (
    process.env["KAREN_RESEARCH_ROLES"] ??
    join(process.env["HOME"] ?? homedir(), ".config", "karen", "research-roles.json")
  );
}

export function readRoleConfig(path = rolesPath()): RoleConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RoleConfig>;
    const models: Partial<Record<Role, string>> = {};
    for (const role of ROLES) {
      const value = parsed.models?.[role];
      if (typeof value === "string" && value.includes("/")) models[role] = value;
    }
    return {
      models,
      ...(typeof parsed.embedModel === "string" && parsed.embedModel
        ? { embedModel: parsed.embedModel }
        : {}),
    };
  } catch {
    return { models: {} };
  }
}

export async function writeRoleConfig(config: RoleConfig, path = rolesPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  await rename(tmp, path); // atomic: a half-written config would break every stage
}

/**
 * Fill in every role, using the active model for anything unassigned.
 *
 * `fallback` is the model the user currently has selected in the app. Using it
 * means a first run works with no configuration at all, which is the whole
 * point -- the alternative is a setup screen before you can ask a question.
 */
export function resolveRoles(config: RoleConfig, fallback: string): ResolvedRoles {
  const resolved = {} as ResolvedRoles;
  for (const role of ROLES) resolved[role] = config.models[role] ?? fallback;

  // Reviewing your own draft is the failure this stage exists to catch, so if
  // nothing else was chosen, say so rather than silently pairing them.
  return resolved;
}

/** True when review would be self-review, which makes the stage near-worthless. */
export function reviewerIsSynthesist(roles: ResolvedRoles): boolean {
  return roles.reviewer === roles.synthesist;
}
