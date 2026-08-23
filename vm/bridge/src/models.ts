/**
 * Reads and writes pi's ~/.pi/agent/models.json on the GUI's behalf.
 *
 * pi reloads this file whenever the model list is consulted, so writing it is
 * enough to make new endpoints appear -- no restart, and the user never has to
 * open a JSON file.
 *
 * SECURITY INVARIANT enforced here: apiKey must be an environment-variable
 * reference such as "$KAREN_LLM_KEY", never a literal secret. Keys live in the
 * host keyring and reach pi only through its process environment; writing one
 * here would put a credential on VM disk and break the central privacy promise.
 * The check is in code rather than convention so a UI bug cannot bypass it.
 */

import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelsConfig, ProviderSpec } from "@karen/protocol";
import { isEnvRef } from "@karen/protocol";
import { log } from "./logger.ts";

export class ModelsConfigError extends Error {
  override readonly name = "ModelsConfigError";
}

export async function readModels(path: string): Promise<ModelsConfig> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as ModelsConfig;
    if (!parsed || typeof parsed !== "object" || typeof parsed.providers !== "object") {
      throw new ModelsConfigError("models.json has no providers object");
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { providers: {} };
    throw err;
  }
}

/**
 * Synchronous read, used at the moment pi is spawned.
 *
 * It must be sync: pi reads this file during startup, and an async read could
 * interleave with a concurrent write, leaving us believing pi holds a catalogue
 * it never saw.
 */
export function readModelsSync(path: string): ModelsConfig | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ModelsConfig;
  } catch {
    return undefined;
  }
}

/** Flatten a config into the {id, provider, name} rows the model dropdown shows. */
export function flattenModels(
  config: ModelsConfig,
): { id: string; provider: string; name: string; baseUrl: string }[] {
  return Object.entries(config.providers).flatMap(([provider, spec]) =>
    (spec.models ?? []).map((m) => ({
      id: m.id,
      provider,
      name: m.name ?? m.id,
      baseUrl: spec.baseUrl,
    })),
  );
}

export function validateModels(config: ModelsConfig): void {
  if (!config || typeof config !== "object" || typeof config.providers !== "object") {
    throw new ModelsConfigError("expected { providers: { ... } }");
  }

  for (const [name, provider] of Object.entries(config.providers)) {
    const p = provider as ProviderSpec;
    if (!p.baseUrl || typeof p.baseUrl !== "string") {
      throw new ModelsConfigError(`provider "${name}" is missing baseUrl`);
    }
    if (!/^https?:\/\//.test(p.baseUrl)) {
      throw new ModelsConfigError(`provider "${name}" baseUrl must be http(s)`);
    }
    if (typeof p.apiKey !== "string" || p.apiKey.length === 0) {
      throw new ModelsConfigError(`provider "${name}" is missing apiKey`);
    }
    if (!isEnvRef(p.apiKey)) {
      // The whole point: no credential may be persisted inside the VM.
      throw new ModelsConfigError(
        `provider "${name}" apiKey must be an env reference like "$KAREN_LLM_KEY", ` +
          `not a literal secret`,
      );
    }
    if (!Array.isArray(p.models) || p.models.length === 0) {
      throw new ModelsConfigError(`provider "${name}" must declare at least one model`);
    }
    for (const m of p.models) {
      if (!m.id || typeof m.id !== "string") {
        throw new ModelsConfigError(`provider "${name}" has a model without an id`);
      }
    }
  }
}

/** Write atomically so a crash mid-write cannot leave pi with a truncated file. */
export async function writeModels(path: string, config: ModelsConfig): Promise<void> {
  validateModels(config);
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.models.json.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, path);
  log.info("wrote models.json", { providers: Object.keys(config.providers).length });
}

/** Env var names referenced by the config, so the host knows which to supply. */
export function referencedEnvVars(config: ModelsConfig): string[] {
  const names = new Set<string>();
  for (const provider of Object.values(config.providers)) {
    const key = (provider as ProviderSpec).apiKey;
    if (isEnvRef(key)) names.add(key.slice(1));
  }
  return [...names];
}
