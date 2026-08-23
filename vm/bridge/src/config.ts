/**
 * Bridge configuration, read from the VM's own config directory.
 *
 * Deliberately NOT here: any API key. Secrets arrive over the authenticated
 * socket after the handshake and live only in pi's process environment, so the
 * VM holds no credentials at rest.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BridgeConfig {
  /** Where the host app listens. 10.0.2.2 is the QEMU SLIRP gateway (the host). */
  hostUrl: string;
  /** Shared secret, provisioned once by install-vm.sh. Mode 0600. */
  token: string;
  /** Absolute path the agent may write to freely. */
  workspaceRoot: string;
  /** Where pi stores session JSONL files. */
  sessionDir: string;
  /** Reconnect backoff bounds, in milliseconds. */
  reconnectMinMs: number;
  reconnectMaxMs: number;
}

/** Overridable so tests can run against a throwaway directory. */
const CONFIG_DIR = process.env["KAREN_CONFIG_DIR"] ?? join(homedir(), ".config", "karen");

export async function loadConfig(): Promise<BridgeConfig> {
  const token = (await readFile(join(CONFIG_DIR, "token"), "utf8")).trim();
  if (!token) throw new Error(`empty token at ${join(CONFIG_DIR, "token")}`);

  let file: Partial<BridgeConfig> = {};
  try {
    file = JSON.parse(await readFile(join(CONFIG_DIR, "bridge.json"), "utf8")) as Partial<BridgeConfig>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  return {
    // The guest reaches the host at the SLIRP gateway; host->guest is not
    // routable without hostfwd, which is why the VM always dials out.
    hostUrl: file.hostUrl ?? process.env["KAREN_HOST_URL"] ?? "ws://10.0.2.2:8765",
    token,
    workspaceRoot: file.workspaceRoot ?? process.env["KAREN_WORKSPACE"] ?? join(homedir(), "Documents", "karen"),
    sessionDir: file.sessionDir ?? join(homedir(), ".pi", "sessions"),
    reconnectMinMs: file.reconnectMinMs ?? 500,
    reconnectMaxMs: file.reconnectMaxMs ?? 30_000,
  };
}

export const CONFIG_PATHS = {
  dir: CONFIG_DIR,
  token: join(CONFIG_DIR, "token"),
  bridge: join(CONFIG_DIR, "bridge.json"),
  piModels: join(homedir(), ".pi", "agent", "models.json"),
  /** Read by the research extension at tool-call time. */
  research: join(CONFIG_DIR, "research.json"),
  /** Read by the guard extension on every tool call. */
  policy: join(CONFIG_DIR, "policy.json"),
  piSettings: join(homedir(), ".pi", "agent", "settings.json"),
} as const;
