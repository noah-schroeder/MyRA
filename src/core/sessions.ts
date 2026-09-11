/**
 * Conversations on disk.
 *
 * v1 delegated this to pi, which owned ~/.pi/sessions and answered
 * get_entries with a durable cursor. That went with pi, and what replaces it is
 * smaller than what it replaces: a conversation is a list of chat messages, and
 * the only thing that needs care is not losing one.
 *
 * One file per session, written atomically. Not a database, and not JSONL --
 * a turn rewrites earlier messages (a tool result is appended to the assistant
 * message that asked for it), so append-only would need compaction to stay
 * truthful, and truthful is the point.
 */

import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage } from "./llm/chat.ts";
import { CONFIG_DIR, makeOwnDir, OWNER_ONLY_FILE } from "./paths.ts";

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: number;
}

export interface Session extends SessionMeta {
  messages_: ChatMessage[];
  /**
   * How much of the model's window this conversation occupies, in tokens.
   *
   * Carried across turns so the meter has a figure before the next reply comes
   * back, and so compaction can decide *before* sending rather than after being
   * refused. Reopening a session starts it at zero: the number belongs to a
   * particular model's window, and the next reply corrects it anyway.
   */
  contextTokens?: number;
  /**
   * The summary standing in for the earliest messages, and how many it covers.
   *
   * Stored so it is made once and reused, rather than redone on every turn past
   * the threshold -- which would cost a full model call per message. The
   * messages it replaces stay in `messages_` untouched: this records what is
   * *sent*, not what happened, which is why `saveSession` does not write it.
   * Reopening a conversation starts from the full history again, correctly: the
   * summary was made to fit one particular model's window, and the model may
   * not be the same one.
   */
  compaction?: { upTo: number; summary: string };
}

export function sessionsDir(): string {
  return process.env["MYRA_SESSIONS_DIR"] ?? join(CONFIG_DIR, "sessions");
}

/** Local calendar fields, not toISOString: a 5:29pm session must file today. */
export function sessionId(now = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `T${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}` +
    `-${p(Math.floor(Math.random() * 4096), 4)}`
  );
}

/**
 * A title from the first thing the user said.
 *
 * Taken from the message rather than asked of the model: a title is worth one
 * line of code, not a network round trip and a wait.
 */
export function titleFrom(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user")?.content ?? "";
  const line = first.replace(/\s+/g, " ").trim();
  if (!line) return "New conversation";
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

function pathFor(id: string): string {
  // The id is generated here and never comes from a user, but it lands in a
  // path, so it is still checked rather than trusted.
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`invalid session id ${JSON.stringify(id)}`);
  return join(sessionsDir(), `${id}.json`);
}

export async function saveSession(session: Session): Promise<void> {
  await makeOwnDir(sessionsDir());
  const path = pathFor(session.id);
  const tmp = `${path}.${process.pid}.tmp`;
  const body = {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: new Date().toISOString(),
    messages: session.messages_,
  };
  // Atomic: a crash mid-write leaves the previous conversation intact rather
  // than a truncated file that parses as an empty one.
  await writeFile(tmp, JSON.stringify(body, null, 2) + "\n", { mode: OWNER_ONLY_FILE });
  await rename(tmp, path);
}

export async function loadSession(id: string): Promise<Session | undefined> {
  try {
    const raw = JSON.parse(await readFile(pathFor(id), "utf8")) as {
      id?: string; title?: string; createdAt?: string; updatedAt?: string; messages?: ChatMessage[];
    };
    const messages = Array.isArray(raw.messages) ? raw.messages : [];
    return {
      id: raw.id ?? id,
      title: raw.title ?? "Untitled",
      createdAt: raw.createdAt ?? new Date().toISOString(),
      updatedAt: raw.updatedAt ?? raw.createdAt ?? new Date().toISOString(),
      messages: messages.length,
      messages_: messages,
    };
  } catch {
    return undefined;
  }
}

/** Newest first. A corrupt file is skipped, not fatal. */
export async function listSessions(): Promise<SessionMeta[]> {
  let names: string[];
  try {
    names = (await readdir(sessionsDir())).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: SessionMeta[] = [];
  for (const name of names) {
    const session = await loadSession(name.slice(0, -5));
    if (session) {
      const { messages_, ...meta } = session;
      void messages_;
      out.push(meta);
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteSession(id: string): Promise<void> {
  await rm(pathFor(id), { force: true });
}

export async function deleteAllSessions(): Promise<void> {
  await rm(sessionsDir(), { recursive: true, force: true });
}
