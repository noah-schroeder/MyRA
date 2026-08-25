/**
 * Where the runtime and its models live.
 *
 * Runtimes go under the app's own data directory: they are ours, they are
 * disposable, and reinstalling the app should be able to take them with it.
 *
 * Models do not. A model directory reaches tens of gigabytes, and the app data
 * directory is on the system disk -- which on a laptop with a 256 GB SSD is
 * exactly where a user does not want it. So the default is inside userData and
 * the setting is a first-class one, changeable in Settings, and re-read on
 * every launch rather than baked in.
 */

import { app } from "electron";
import { join } from "node:path";

export function runtimesDir(): string {
  return join(app.getPath("userData"), "runtimes");
}

/** One installed build: `runtimes/llama.cpp/b10628-vulkan/`. */
export function buildDir(tag: string, backend: string): string {
  return join(runtimesDir(), "llama.cpp", `${tag}-${backend}`);
}

export function defaultModelsDir(): string {
  return join(app.getPath("userData"), "models");
}

/** Downloads in progress, so a cancelled one leaves nothing half-formed behind. */
export function stagingDir(): string {
  return join(app.getPath("userData"), "staging");
}
