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

/**
 * Where the Lemonade daemon and its state live.
 *
 * Versioned, so an upgrade installs beside the old one rather than over it --
 * the same discipline the llama.cpp builds use, and for the same reason: a bad
 * version should be recoverable without a download.
 *
 * The cache holds downloaded backends and models and reaches tens of gigabytes,
 * so it is deliberately separate from the daemon itself and is passed in rather
 * than assumed -- Settings already owns a models directory, and this should be
 * able to follow it.
 */
export function lemonadeDir(version: string): string {
  return join(runtimesDir(), "lemonade", version);
}

/** Lemonade's own JSON state: config.json, jobs.json. Small, ours, disposable. */
export function lemonadeConfigDir(): string {
  return join(app.getPath("userData"), "lemonade", "config");
}

/**
 * The single directory Lemonade is told about, built out of symlinks.
 *
 * `extra_models_dir` takes one path and one only, so everything Karen can
 * offer -- its own downloads, and whatever LM Studio and Ollama already hold --
 * has to be reachable from here. Disposable: it is rebuilt from scratch on
 * every start and contains no data of its own.
 */
export function lemonadeIndexDir(): string {
  return join(app.getPath("userData"), "lemonade", "models-index");
}

/** Default cache location, used until the models directory setting is wired in. */
export function lemonadeCacheDir(): string {
  return join(app.getPath("userData"), "lemonade", "cache");
}
