/**
 * Session history: listing, and deleting it properly.
 *
 * Sessions are JSONL files pi writes; nothing else indexes them, so listing is
 * a directory read and a peek at the first user message for a title.
 *
 * Deleting is the part that needs care. "Delete this chat" has to mean the
 * conversation AND what it produced, or the interesting content -- a research
 * run with its retrieved sources -- outlives the chat that created it and sits
 * on disk unreferenced. So a delete also removes the research runs that session
 * started, identified by scanning the transcript for run ids.
 */

import { readdir, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export interface SessionSummary {
  /** The file's basename, which is also its handle in the API. */
  id: string;
  path: string;
  title: string;
  /** ISO timestamp of the session's creation. */
  at: string;
  updatedAt: string;
  messages: number;
  /** Research runs this session started. Deleted with it. */
  runs: string[];
}

/**
 * Run ids look like `2026-08-19-some-slug-a1b2`.
 *
 * Matched strictly, and never used as a path directly: a delete resolves the
 * candidate inside the research root and refuses anything that escapes it.
 */
const RUN_ID = /\b(\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*-[0-9a-f]{4})\b/g;

const MAX_TITLE = 90;

function titleFrom(text: string): string {
  const clean = text
    // The GUI composes a directive around deep-research questions; showing it
    // as the title would make every research chat look identical.
    .replace(/^Run deep_research with this question[^:]*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > MAX_TITLE ? `${clean.slice(0, MAX_TITLE - 1)}…` : clean;
}

interface Entry {
  type?: string;
  timestamp?: string;
  message?: { role?: string; content?: { type?: string; text?: string }[] };
}

/** Read one session file into a summary. Never throws for a malformed file. */
export async function summarize(path: string): Promise<SessionSummary | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }

  let at = "";
  let title = "";
  let messages = 0;
  let lastAt = "";
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue; // a torn final line must not lose the rest of the file
    }
    if (entry.timestamp) lastAt = entry.timestamp;
    if (entry.type === "session" && entry.timestamp) at = entry.timestamp;
    if (entry.type !== "message") continue;
    messages++;
    if (!title && entry.message?.role === "user") {
      const text = (entry.message.content ?? [])
        .filter((c) => c?.type === "text")
        .map((c) => c.text ?? "")
        .join(" ");
      if (text.trim()) title = titleFrom(text);
    }
  }

  const stats = await stat(path).catch(() => undefined);
  const runs = [...new Set([...raw.matchAll(RUN_ID)].map((m) => m[1]!))];

  return {
    id: basename(path),
    path,
    title: title || "(empty conversation)",
    at: at || stats?.birthtime.toISOString() || "",
    updatedAt: lastAt || stats?.mtime.toISOString() || "",
    messages,
    runs,
  };
}

/** Every session, newest first. */
export async function listSessions(sessionDir: string): Promise<SessionSummary[]> {
  const names = await readdir(sessionDir).catch(() => []);
  const files = names.filter((n) => n.endsWith(".jsonl"));
  const out: SessionSummary[] = [];
  for (const name of files) {
    const summary = await summarize(join(sessionDir, name));
    if (summary) out.push(summary);
  }
  return out.sort((a, b) => (b.updatedAt || b.at).localeCompare(a.updatedAt || a.at));
}

export interface DeleteResult {
  session: string;
  runsDeleted: string[];
}

/**
 * Delete one session and the research runs it started.
 *
 * Both paths are resolved and checked to be inside their roots before anything
 * is removed. The id comes from a client, and a delete that follows `../` out
 * of the session directory would be the worst bug in this file.
 */
export async function deleteSession(
  id: string,
  sessionDir: string,
  researchRoot: string,
): Promise<DeleteResult> {
  const path = resolve(sessionDir, id);
  if (!path.startsWith(resolve(sessionDir) + "/") || !path.endsWith(".jsonl")) {
    throw new Error(`refusing to delete outside the session directory: ${id}`);
  }
  const summary = await summarize(path);
  const runsDeleted: string[] = [];

  for (const run of summary?.runs ?? []) {
    const dir = resolve(researchRoot, run);
    if (!dir.startsWith(resolve(researchRoot) + "/")) continue;
    if (!existsSync(dir)) continue;
    await rm(dir, { recursive: true, force: true });
    runsDeleted.push(run);
  }

  await rm(path, { force: true });
  return { session: id, runsDeleted };
}

export interface ClearResult {
  sessions: number;
  runsDeleted: number;
}

/** Delete every session, and every research run any of them started. */
export async function deleteAllSessions(
  sessionDir: string,
  researchRoot: string,
): Promise<ClearResult> {
  const sessions = await listSessions(sessionDir);
  let runsDeleted = 0;
  for (const s of sessions) {
    const result = await deleteSession(s.id, sessionDir, researchRoot).catch(() => undefined);
    runsDeleted += result?.runsDeleted.length ?? 0;
  }
  return { sessions: sessions.length, runsDeleted };
}
