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
