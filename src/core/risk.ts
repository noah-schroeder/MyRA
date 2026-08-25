/**
 * Heuristic risk classification for tool calls.
 *
 * IMPORTANT FRAMING: this is defence in depth, not a security boundary. Shell
 * is not reliably parseable, and a determined adversary can obfuscate past any
 * pattern list. What actually contains a hostile agent is the VM plus the host
 * broker's tiny verb allowlist. This classifier exists to
 *   (a) stop honest accidents,
 *   (b) catch the obvious shapes prompt injection takes, and
 *   (c) decide when to interrupt the user.
 *
 * Accordingly it FAILS TOWARD CAUTION: anything it cannot confidently place is
 * `dangerous` (ask), never `safe`. Adding a pattern is cheap; a false negative
 * that silently runs is not.
 *
 * No node: imports here -- this module is shared with the renderer, so all path
 * logic is POSIX string handling.
 */

import type { PolicyVerdict, RiskClass } from "./policy.ts";
import { isFloorClass } from "./policy.ts";

/* ------------------------------------------------------------------ *
 * Path helpers (POSIX, no fs access -- the broker does realpath)      *
 * ------------------------------------------------------------------ */

export function normalizePosixPath(p: string): string {
  const isAbsolute = p.startsWith("/");
  const out: string[] = [];
  for (const segment of p.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!isAbsolute) out.push("..");
      continue;
    }
    out.push(segment);
  }
  return (isAbsolute ? "/" : "") + out.join("/");
}

/**
 * Lexical containment test. The broker MUST additionally resolve symlinks with
 * realpath before trusting this -- a symlink inside the jail can point outside.
 */
export function isInside(child: string, root: string): boolean {
  const c = normalizePosixPath(child);
  const r = normalizePosixPath(root).replace(/\/$/, "");
  if (r === "") return true;
  return c === r || c.startsWith(r + "/");
}

/* ------------------------------------------------------------------ *
 * Shell command classification                                        *
 * ------------------------------------------------------------------ */

interface Pattern {
  re: RegExp;
  reason: string;
}

/**
 * Unrecoverable. These require manual approval in EVERY mode, including yolo.
 */
const CATASTROPHIC: Pattern[] = [
  { re: /\bmkfs(\.\w+)?\b/, reason: "formats a filesystem" },
  { re: /\bwipefs\b/, reason: "erases filesystem signatures" },
  { re: /\bdd\b[^|;&]*\bof=\/dev\/(sd|nvme|vd|hd|mmcblk)/, reason: "raw write to a block device" },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork bomb" },
  { re: /\bshred\b[^|;&]*\/dev\//, reason: "shreds a block device" },
  { re: />\s*\/dev\/(sd|nvme|vd|hd|mmcblk)/, reason: "redirect over a block device" },
  { re: /\bchmod\b[^|;&]*\s-[a-z]*R[a-z]*\s[^|;&]*\s\/(\s|$)/, reason: "recursive chmod of the filesystem root" },
  { re: /\bchown\b[^|;&]*\s-[a-z]*R[a-z]*\s[^|;&]*\s\/(\s|$)/, reason: "recursive chown of the filesystem root" },
];

/** Destructive, privileged, or exfiltration-shaped. Auto only in yolo. */
const DANGEROUS: Pattern[] = [
  { re: /\brm\b\s+(-[^\s]+\s+)*(-[a-z]*[rR])/, reason: "recursive delete" },
  { re: /\bsudo\b|\bpkexec\b|\bdoas\b/, reason: "privilege escalation" },
  { re: /\bdd\b\s/, reason: "raw disk copy" },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|k|fi|da)?sh\b/, reason: "pipes a download into a shell" },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(python3?|perl|ruby|node)\b/, reason: "pipes a download into an interpreter" },
  { re: /\bapt(-get)?\b\s+(install|remove|purge)|\bdpkg\b\s+-i|\bsnap\b\s+(install|remove)|\bflatpak\b\s+(install|uninstall)/, reason: "system package change" },
  { re: /\bnpm\b\s+(i|install)\b[^|;&]*\s-g|\bnpm\b\s+install\b[^|;&]*--global/, reason: "global npm install" },
  { re: /\bpip3?\b\s+install\b/, reason: "python package install" },
  { re: /\bgit\b\s+push\b/, reason: "publishes commits to a remote" },
  { re: /\bgit\b\s+(reset\s+--hard|clean\s+-[a-z]*f)/, reason: "discards uncommitted work" },
  { re: /\bchmod\b[^|;&]*\s-[a-z]*R/, reason: "recursive permission change" },
  { re: /\bkill(all)?\b\s+-9\s+-1|\bkillall5\b/, reason: "kills every process" },
  { re: /\bcrontab\b|\bsystemctl\b\s+(enable|start|disable|stop)|\bat\b\s+now/, reason: "changes scheduled or system services" },
  { re: /\bssh-keygen\b|\.ssh\/(id_|authorized_keys)/, reason: "touches SSH credentials" },
  { re: /\bhistory\b\s+-c|\bshred\b|\btruncate\b\s+-s\s*0/, reason: "destroys evidence or data" },
  { re: /\bnc\b\s+-[a-z]*l|\bncat\b|\bsocat\b/, reason: "opens a network listener" },
  { re: /\bmount\b|\bumount\b|\bfdisk\b|\bparted\b|\blosetup\b/, reason: "alters storage configuration" },
  { re: /\biptables\b|\bnft\b|\bufw\b/, reason: "alters firewall rules" },
  { re: />\s*\/etc\/|\btee\b[^|;&]*\s\/etc\//, reason: "writes to system configuration" },
];

/** Paths whose mere mention makes a command sensitive. */
const SENSITIVE_PATHS: Pattern[] = [
  { re: /~\/\.ssh|\/\.ssh\//, reason: "SSH private keys" },
  { re: /~\/\.pi(\/|\b)/, reason: "pi agent configuration" },
  { re: /\.config\/karen/, reason: "Karen configuration and secrets" },
  { re: /\bsecrets\.enc\.json\b|\bauth\.json\b/, reason: "stored credentials" },
  { re: /~\/\.gnupg|\/\.gnupg\//, reason: "GPG private keys" },
  { re: /\/etc\/(shadow|passwd|sudoers)/, reason: "system account files" },
];

/** Read-only shell verbs we are willing to call safe. */
const SAFE_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "grep", "rg", "find", "wc", "file", "stat",
  "pwd", "echo", "date", "which", "whoami", "env", "printenv", "du", "df",
  "sort", "uniq", "cut", "awk", "sed", "jq", "diff", "tree", "basename",
  "dirname", "realpath", "readlink", "man", "type", "id", "uname", "hostname",
]);

/**
 * Split a command line into independently-classifiable segments.
 *
 * We also break on command-substitution delimiters (backticks, `$(`, `)`), so a
 * dangerous command hidden inside a substitution is classified on its own merits
 * rather than being masked by a benign outer command.
 */
function splitSegments(command: string): string[] {
  return command
    .split(/\n|;|&&|\|\||\||&|`|\$\(|\)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function firstWord(segment: string): string {
  // Skip leading env assignments such as FOO=bar cmd
  const tokens = segment.split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
    return t.replace(/^.*\//, "");
  }
  return "";
}

export interface RiskAssessment {
  risk: RiskClass;
  reason: string;
}

/**
 * `rm` is classified by TARGET, not merely by flags.
 *
 * `rm -rf build` is routine and must stay `dangerous`, or yolo would prompt on
 * ordinary cleanup and the mode would be worthless. Only removals aimed at a
 * filesystem or home root are unrecoverable enough to be `catastrophic`.
 */
const ROOTISH_TARGET =
  /^(\/|\/\*|~|~\/|~\/\*|\$HOME|\$\{HOME\}|\/(bin|boot|dev|etc|home|lib|proc|root|sbin|srv|sys|usr|var)\/?\*?)$/;

export function classifyRm(segment: string): RiskAssessment | undefined {
  if (!/\brm\b/.test(segment)) return undefined;

  const tokens = segment.split(/\s+/).filter(Boolean);
  const rmIndex = tokens.findIndex((t) => t.replace(/^.*\//, "") === "rm");
  if (rmIndex === -1) return undefined;

  const rest = tokens.slice(rmIndex + 1);
  const flags = rest.filter((t) => t.startsWith("-"));
  const targets = rest.filter((t) => !t.startsWith("-"));

  const recursive = flags.some((f) => /^-[a-zA-Z]*[rR]/.test(f) || f === "--recursive");
  const noPreserveRoot = flags.includes("--no-preserve-root");

  if (recursive && targets.some((t) => ROOTISH_TARGET.test(t))) {
    return { risk: "catastrophic", reason: "recursive delete of a filesystem or home root" };
  }
  if (noPreserveRoot) {
    return { risk: "catastrophic", reason: "rm --no-preserve-root" };
  }
  if (recursive) {
    return { risk: "dangerous", reason: "recursive delete" };
  }
  return { risk: "dangerous", reason: "deletes files" };
}

export function classifyBash(command: string): RiskAssessment {
  const cmd = command.trim();
  if (cmd === "") return { risk: "safe", reason: "empty command" };

  for (const segment of splitSegments(cmd)) {
    const rm = classifyRm(segment);
    if (rm) return rm;
  }

  for (const { re, reason } of CATASTROPHIC) {
    if (re.test(cmd)) return { risk: "catastrophic", reason };
  }
  for (const { re, reason } of DANGEROUS) {
    if (re.test(cmd)) return { risk: "dangerous", reason };
  }
  for (const { re, reason } of SENSITIVE_PATHS) {
    if (re.test(cmd)) return { risk: "dangerous", reason: `references ${reason}` };
  }

  // Only call it safe when EVERY segment is a known read-only verb and there is
  // no redirection. Anything else is unclassified, and unclassified means ask.
  const segments = splitSegments(cmd);
  const allSafe =
    segments.length > 0 &&
    segments.every((s) => SAFE_COMMANDS.has(firstWord(s))) &&
    !/>|>>|\btee\b/.test(cmd) &&
    !/\$\(|`/.test(cmd); // command substitution hides the real verb

  if (allSafe) return { risk: "safe", reason: "read-only command" };

  return { risk: "dangerous", reason: "unrecognised command; classified cautiously" };
}

/* ------------------------------------------------------------------ *
 * Tool call classification                                            *
 * ------------------------------------------------------------------ */

/** pi's built-in read-only tools. */
/**
 * pi's read-only built-ins, by their real names.
 *
 * Checked against the installed pi rather than guessed: the built-in tools are
 * read, write, edit, bash, grep, find, ls and tree. This list previously held
 * "list" and "glob", which pi has never had, and omitted "find" and "ls", which
 * it does -- so in Guarded mode every directory listing raised a red
 * typed-confirmation prompt. That is worse than it sounds: prompt fatigue on
 * harmless calls is exactly what pushes people into YOLO, where the prompts
 * that matter stop appearing too.
 */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "tree"]);
/** Tools that write files. */
const WRITE_TOOLS = new Set(["write", "edit", "multi_edit", "apply_patch"]);

export interface ClassifyContext {
  /** Absolute POSIX path the agent may write to freely, inside the VM. */
  workspaceRoot: string;
}

function extractPaths(args: Record<string, unknown>): string[] {
  const keys = ["path", "file_path", "filePath", "filename", "target", "dest", "destination"];
  const out: string[] = [];
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.length > 0) out.push(v);
  }
  return out;
}

/**
 * Tools that reach the network and cause no local side effects.
 *
 * Kept as a set, and covered by a test that checks it against the extension's
 * registered tool names, so a renamed or added tool cannot silently start
 * prompting on every call.
 */
/**
 * Document tools. All of them work inside the agent's own documents folder and
 * nowhere else -- the path is validated in the extension before anything runs,
 * so these are the sandbox writes that Guarded deliberately does not prompt on.
 */
export const DOCUMENT_WRITE_TOOLS = new Set(["write_document", "convert_document"]);
export const DOCUMENT_READ_TOOLS = new Set(["read_document"]);

export const RESEARCH_TOOLS = new Set([
  "web_search",
  "fetch_page",
  "deep_research",
  "academic_research",
]);

export function classifyToolCall(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ClassifyContext,
): PolicyVerdict {
  const finish = (risk: RiskClass, reason: string): PolicyVerdict => ({
    risk,
    reason,
    decision: "ask", // overwritten by the caller via decide(); placeholder
    floor: isFloorClass(risk),
  });

  if (toolName === "bash" || toolName === "shell") {
    const command = typeof args["command"] === "string" ? (args["command"] as string) : "";
    const { risk, reason } = classifyBash(command);
    return finish(risk, reason);
  }

  if (READ_ONLY_TOOLS.has(toolName)) {
    return finish("safe", "read-only tool");
  }

  if (WRITE_TOOLS.has(toolName)) {
    const paths = extractPaths(args);
    if (paths.length === 0) return finish("dangerous", "write with no discernible path");
    for (const p of paths) {
      for (const { re, reason } of SENSITIVE_PATHS) {
        if (re.test(p)) return finish("dangerous", `writes to ${reason}`);
      }
      if (!isInside(p, ctx.workspaceRoot)) {
        return finish("dangerous", `writes outside the workspace (${p})`);
      }
    }
    return finish("write", "write inside the workspace");
  }

  // Research and search tools reach the network but cause no local side effects.
  //
  // These names must match the tools actually registered in
  // vm/extensions/research/. "fetch_url" never existed -- the tool is
  // `fetch_page` -- so every page fetch fell through to the unknown-tool branch
  // and was classified `dangerous`, which in Guarded means a prompt per fetch.
  // A guard that interrupts constantly is a guard the user turns off.
  if (RESEARCH_TOOLS.has(toolName)) {
    return finish("safe", "read-only research tool");
  }

  if (DOCUMENT_READ_TOOLS.has(toolName)) {
    return finish("safe", "reads a document in the agent's own folder");
  }

  if (DOCUMENT_WRITE_TOOLS.has(toolName)) {
    return finish("write", "writes a document in the agent's own folder");
  }

  return finish("dangerous", `unknown tool "${toolName}"; classified cautiously`);
}
