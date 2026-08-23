/**
 * The host broker: the only place the sandboxed agent can affect this machine.
 *
 * pi has no sandbox of its own -- its docs say so plainly, and inside the VM it
 * runs with the full permissions of its process. That is fine, because the VM is
 * the containment. This module is the one door out of it, so it is deliberately
 * tiny and deliberately boring:
 *
 *   1. allowlist   an unknown verb is rejected outright, never interpreted
 *   2. policy      mode x risk decides auto vs ask; the floor cannot be lowered
 *   3. path jail   realpath-resolved containment, so symlinks cannot escape
 *   4. audit       every attempt is appended to a log the user can read
 *
 * There is intentionally no shell verb and no general filesystem write. Document
 * work happens in the VM; files reach the host only through a save dialog the
 * user drives.
 */

import { appendFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { clipboard, Notification } from "electron";
import type { ActionRequestFrame, PermissionMode, PolicyVerdict } from "@karen/protocol";
import { HOST_VERB_RISK, decide, isFloorClass, isHostVerb } from "@karen/protocol";
import { createEvent, listEvents, searchContacts } from "./eds.ts";
import { CONFIG_DIR } from "./paths.ts";
import type { Settings } from "./config.ts";

const execFileAsync = promisify(execFile);
const AUDIT_PATH = join(CONFIG_DIR, "audit.jsonl");

export interface ApprovalRequest {
  verb: string;
  args: Record<string, unknown>;
  verdict: PolicyVerdict;
}

export interface BrokerOptions {
  getSettings: () => Settings;
  /** Ask the user. Resolves true to allow. */
  requestApproval: (req: ApprovalRequest) => Promise<boolean>;
}

export class BrokerError extends Error {
  override readonly name = "BrokerError";
}

export class Broker {
  readonly #opts: BrokerOptions;
  /** Verbs the user chose to always allow, for this run only. */
  #sessionAllow = new Set<string>();

  constructor(opts: BrokerOptions) {
    this.#opts = opts;
  }

  clearSessionApprovals(): void {
    this.#sessionAllow.clear();
  }

  async handle(frame: ActionRequestFrame): Promise<unknown> {
    const { verb, args } = frame;

    // 1. Allowlist. Anything unrecognised dies here, before interpretation.
    if (!isHostVerb(verb)) {
      await this.#audit(verb, args, "rejected", "verb is not on the allowlist");
      throw new BrokerError(`unknown host verb: ${verb}`);
    }

    const risk = HOST_VERB_RISK[verb];
    const mode: PermissionMode = this.#opts.getSettings().permissionMode;
    const decision = decide(mode, risk);
    const verdict: PolicyVerdict = {
      risk,
      decision,
      reason: `${verb} is classified ${risk}`,
      floor: isFloorClass(risk),
    };

    // 2. Policy. Floor classes always ask, in every mode, and a session-wide
    //    "always allow" cannot be used to skip them either.
    if (decision === "ask" && !(this.#sessionAllow.has(verb) && !verdict.floor)) {
      const approved = await this.#opts.requestApproval({ verb, args, verdict });
      if (!approved) {
        await this.#audit(verb, args, "denied", "user declined");
        throw new BrokerError(`denied by user: ${verb}`);
      }
    }

    try {
      const result = await this.#dispatch(verb, args);
      await this.#audit(verb, args, "allowed", verdict.reason);
      return result;
    } catch (err) {
      await this.#audit(verb, args, "failed", (err as Error).message);
      throw err;
    }
  }

  allowForSession(verb: string): void {
    // Never let a floor verb be blanket-approved.
    if (isHostVerb(verb) && !isFloorClass(HOST_VERB_RISK[verb])) this.#sessionAllow.add(verb);
  }

  /* ---------------- verb implementations ---------------- */

  async #dispatch(verb: string, args: Record<string, unknown>): Promise<unknown> {
    switch (verb) {
      case "notify":
        return this.#notify(args);
      case "vault.read":
        return this.#vaultRead(args);
      case "vault.write":
        return this.#vaultWrite(args);
      case "clipboard.read":
        return { text: clipboard.readText() };
      case "clipboard.write":
        clipboard.writeText(String(args["text"] ?? ""));
        return { written: true };
      case "planify.list":
        return this.#planify(["list", ...this.#planifyArgs(args)]);
      case "planify.propose":
        // Proposals are surfaced in the review queue; committing is a separate,
        // user-driven step. The agent never creates a task directly.
        return { proposed: true, task: args };
      case "calendar.list":
        return { events: await listEvents(this.#eventRange(args)) };
      case "contacts.search":
        return {
          contacts: await searchContacts({
            query: String(args["query"] ?? ""),
            ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}),
          }),
        };
      case "calendar.propose_event":
        // Same shape as planify.propose: a proposal, never a write. The event
        // is created only when the user clicks it in the review queue.
        return { proposed: true, event: args };
      default:
        throw new BrokerError(`unhandled verb: ${verb}`);
    }
  }

  /** Narrow the args for a calendar read, leaving the defaults to eds.ts. */
  #eventRange(args: Record<string, unknown>): { from?: string; to?: string; limit?: number } {
    return {
      ...(typeof args["from"] === "string" && args["from"] ? { from: args["from"] } : {}),
      ...(typeof args["to"] === "string" && args["to"] ? { to: args["to"] } : {}),
      ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}),
    };
  }

  #notify(args: Record<string, unknown>): { shown: boolean } {
    const title = String(args["title"] ?? "Karen");
    const body = String(args["body"] ?? "");
    new Notification({ title, body }).show();
    return { shown: true };
  }

  /* ---------------- vault, with a real path jail ---------------- */

  /**
   * Resolve a vault-relative path and prove it stays inside the jail.
   *
   * Lexical checks alone are not enough: a symlink inside the jail can point
   * anywhere. We realpath the nearest existing ancestor, which defeats that.
   */
  async #resolveInVault(rel: string, forWrite: boolean): Promise<string> {
    const s = this.#opts.getSettings();
    if (!s.vaultRoot) throw new BrokerError("no vault configured");

    const jailRoot = forWrite ? join(s.vaultRoot, s.vaultWriteSubdir) : s.vaultRoot;
    const candidate = resolvePath(jailRoot, rel);

    // Walk up to the nearest ancestor that exists, and resolve that.
    let probe = candidate;
    for (;;) {
      try {
        const real = await realpath(probe);
        const realJail = await realpath(jailRoot).catch(() => jailRoot);
        const suffix = candidate.slice(probe.length);
        const finalPath = real + suffix;
        if (finalPath !== realJail && !finalPath.startsWith(realJail + "/")) {
          throw new BrokerError(
            `path escapes the vault jail (${forWrite ? "writes" : "reads"} are confined to ${realJail})`,
          );
        }
        return finalPath;
      } catch (err) {
        if (err instanceof BrokerError) throw err;
        const parent = dirname(probe);
        if (parent === probe) throw new BrokerError("could not resolve path");
        probe = parent;
      }
    }
  }

  async #vaultRead(args: Record<string, unknown>): Promise<{ path: string; content: string }> {
    const rel = String(args["path"] ?? "");
    if (!rel) throw new BrokerError("path is required");
    const abs = await this.#resolveInVault(rel, false);
    return { path: abs, content: await readFile(abs, "utf8") };
  }

  async #vaultWrite(args: Record<string, unknown>): Promise<{ path: string; bytes: number }> {
    const rel = String(args["path"] ?? "");
    const content = String(args["content"] ?? "");
    if (!rel) throw new BrokerError("path is required");
    const abs = await this.#resolveInVault(rel, true);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    return { path: abs, bytes: Buffer.byteLength(content) };
  }

  /* ---------------- planify ---------------- */

  #planifyArgs(args: Record<string, unknown>): string[] {
    const out: string[] = [];
    const map: Record<string, string> = {
      content: "--content", project: "--project", priority: "--priority",
      due: "--due", labels: "--labels", description: "--description",
    };
    for (const [key, flag] of Object.entries(map)) {
      const v = args[key];
      if (v !== undefined && v !== null && v !== "") out.push(flag, String(v));
    }
    return out;
  }

  async #planify(args: string[]): Promise<unknown> {
    const argv = [
      "run", "--command=io.github.alainm23.planify.cli",
      "io.github.alainm23.planify", ...args,
    ];
    try {
      const { stdout } = await execFileAsync("flatpak", argv, { timeout: 15_000 });
      try {
        return JSON.parse(stdout);
      } catch {
        return { output: stdout.trim() };
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") throw new BrokerError("flatpak is not installed on this host");
      throw new BrokerError(`planify CLI failed: ${(err as Error).message}`);
    }
  }

  /**
   * Create a previously proposed event. Driven by the user, not the agent.
   *
   * There is deliberately no path from a tool call to this method: the agent's
   * verb returns a proposal, and only a click in the review queue arrives here.
   */
  async commitProposedEvent(event: Record<string, unknown>): Promise<unknown> {
    const summary = String(event["title"] ?? event["summary"] ?? "").trim();
    const start = String(event["start"] ?? "").trim();
    if (!summary) throw new BrokerError("an event needs a title");
    if (!start) throw new BrokerError("an event needs a start time");
    const result = await createEvent({
      summary,
      start,
      ...(event["end"] ? { end: String(event["end"]) } : {}),
      ...(event["location"] ? { location: String(event["location"]) } : {}),
      ...(event["description"] ? { description: String(event["description"]) } : {}),
    });
    await this.#audit("calendar.create_event", event, "allowed", "committed from review queue");
    return result;
  }

  /**
   * Write a meeting report into the vault.
   *
   * Driven by the user finishing a meeting, not by the agent — but it goes
   * through the same jail and the same audit log as `vault.write`, because a
   * path that escapes `<Vault>/Karen/**` is exactly as bad whichever side of
   * the app asked for it.
   */
  async saveToVault(rel: string, content: string): Promise<{ path: string; bytes: number }> {
    const result = await this.#vaultWrite({ path: rel, content });
    await this.#audit("vault.write", { path: rel, bytes: result.bytes }, "allowed", "meeting report");
    return result;
  }

  /** Commit a previously proposed task. Driven by the user, not the agent. */
  async commitProposedTask(task: Record<string, unknown>): Promise<unknown> {
    const result = await this.#planify(["add", ...this.#planifyArgs(task)]);
    await this.#audit("planify.add", task, "allowed", "committed from review queue");
    return result;
  }

  /* ---------------- audit ---------------- */

  async #audit(
    verb: string,
    args: Record<string, unknown>,
    outcome: "allowed" | "denied" | "rejected" | "failed",
    reason: string,
  ): Promise<void> {
    const entry = { at: new Date().toISOString(), verb, outcome, reason, args: summarize(args) };
    try {
      await mkdir(CONFIG_DIR, { recursive: true });
      await appendFile(AUDIT_PATH, JSON.stringify(entry) + "\n", { mode: 0o600 });
    } catch {
      // Auditing must never break the action path.
    }
  }

  async readAudit(limit = 200): Promise<unknown[]> {
    try {
      const raw = await readFile(AUDIT_PATH, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      return lines.slice(-limit).map((l) => JSON.parse(l) as unknown);
    } catch {
      return [];
    }
  }
}

/** Keep the audit log readable, and never let it become a copy of the data. */
function summarize(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string") out[k] = v.length > 200 ? `${v.slice(0, 200)}… (${v.length} chars)` : v;
    else out[k] = v;
  }
  return out;
}
