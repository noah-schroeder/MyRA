/**
 * Where Karen keeps its own files on the host.
 *
 * Its own module so that config and the broker can find it without importing
 * the secret vault, which imports Electron -- and a module that imports
 * Electron cannot be loaded by the test runner at all. One shared constant was
 * quietly making the app's configuration untestable.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR =
  process.env["KAREN_CONFIG_DIR"] ?? join(homedir(), ".config", "karen");

/**
 * Where downloaded helper binaries live.
 *
 * Not `vendor/`: that sits inside the installed application bundle, which is
 * read-only on every platform we ship to and is wiped by the next update. A
 * tool fetched on first run belongs with the user's own data, beside the model
 * runtime, which is downloaded for exactly the same reasons.
 */
export function toolsDir(): string {
  return process.env["KAREN_TOOLS_DIR"] ?? join(CONFIG_DIR, "tools");
}
