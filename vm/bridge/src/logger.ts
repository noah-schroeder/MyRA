/**
 * Minimal stderr logger.
 *
 * Never logs secret values or prompt content: the bridge sits on the path of
 * everything the user says to the agent, and a log file is exactly the sort of
 * at-rest leak this project exists to avoid.
 */

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env["KAREN_LOG_LEVEL"] as Level) ?? "info"] ?? ORDER.info;

function emit(level: Level, msg: string, extra?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const line = { t: new Date().toISOString(), level, msg, ...extra };
  process.stderr.write(JSON.stringify(line) + "\n");
}

export const log = {
  debug: (m: string, e?: Record<string, unknown>) => emit("debug", m, e),
  info: (m: string, e?: Record<string, unknown>) => emit("info", m, e),
  warn: (m: string, e?: Record<string, unknown>) => emit("warn", m, e),
  error: (m: string, e?: Record<string, unknown>) => emit("error", m, e),
};

/** Redact anything that looks like a credential before it reaches a log line. */
export function redact(value: string): string {
  return value.replace(/(sk-|key-|Bearer\s+)[A-Za-z0-9_\-]{8,}/gi, "$1<redacted>");
}
