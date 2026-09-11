/**
 * Turning a project into a folder somebody can keep.
 *
 * This is the answer to "can it all be stored together?". The project itself is
 * an index -- see [project.ts](./project.ts) for why -- and colocation is a
 * thing you ask for rather than a thing you live in. That turns out to be the
 * better shape anyway: what you want when you say "all together" is usually a
 * folder to archive or to send a co-author, and neither of those wants MyRA's
 * internal layout. They want the conversations readable, the notes and the
 * report as documents, and the pictures as pictures.
 *
 * Split the way the rest of the app splits: this decides **what goes where**
 * and returns it as a list of operations, and
 * [main/projects.ts](../../main/projects.ts) performs them. So the layout, the
 * naming and the collision handling are testable with no disk and no Electron.
 */

import type { Member, Project } from "./project.ts";

/** One thing the export does. Performed in order. */
export type ExportOp =
  | { op: "write"; path: string; text: string }
  | { op: "copyFile"; path: string; from: string }
  | { op: "copyDir"; path: string; from: string };

/**
 * A member, resolved by main into whatever that store can offer.
 *
 * Deliberately a union of possibilities rather than five shapes: the five
 * stores differ in what they hold -- a conversation is text MyRA renders, a
 * run is a directory of its own audit trail -- and one optional-field record
 * keeps the layout decision in one function instead of five.
 */
export interface ExportItem {
  member: Member;
  /** What to call it, in a filename and in the index. */
  title: string;
  /** ISO date, for the index. Empty if the store did not record one. */
  at: string;
  /** Written as this item's document. Conversations and papers. */
  text?: string | undefined;
  /** Copied wholesale. Research runs, which are their own audit trail. */
  dir?: string | undefined;
  /** Copied individually, into this item's folder. Meetings and images. */
  files?: { name: string; from: string }[] | undefined;
  /** One line of context for the index: a prompt, a duration, a source count. */
  note?: string | undefined;
}

const FOLDERS: Record<Member["kind"], string> = {
  chat: "conversations",
  meeting: "meetings",
  run: "research",
  paper: "papers",
  review: "reviews",
  image: "images",
};

const HEADINGS: Record<Member["kind"], string> = {
  chat: "Conversations",
  meeting: "Meetings",
  run: "Research runs",
  paper: "Papers",
  review: "Peer reviews",
  image: "Images",
};

/** Order the index reads in: what you made, then what went into making it. */
const ORDER: Member["kind"][] = ["paper", "review", "run", "meeting", "chat", "image"];

/**
 * A title as a filename: readable, and safe on every platform we ship to.
 *
 * Not the aggressive slug ids use. This name is read in a file manager by
 * somebody looking for their own work, so spaces and capitals are kept and only
 * what a filesystem objects to is taken out -- including the Windows-reserved
 * characters, because an export folder is exactly the thing that gets copied
 * onto a shared drive.
 */
export function fileName(title: string, fallback = "untitled"): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

/**
 * Make each name unique within its folder.
 *
 * Two papers both called "Draft" is not a corner case, it is Tuesday. Silently
 * overwriting the first with the second would lose work in the one feature
 * whose whole purpose is keeping it.
 */
function uniqueIn(used: Set<string>, name: string): string {
  const key = name.toLowerCase();
  if (!used.has(key)) {
    used.add(key);
    return name;
  }
  for (let n = 2; ; n++) {
    const candidate = `${name} ${n}`;
    if (!used.has(candidate.toLowerCase())) {
      used.add(candidate.toLowerCase());
      return candidate;
    }
  }
}

/** `3 September 2026`, or nothing when the store recorded no date. */
function readableDate(iso: string): string {
  if (!iso) return "";
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? ""
    : at.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

export interface ExportedPlan {
  ops: ExportOp[];
  /** What the index says, so the caller can report the same thing. */
  counts: { kind: Member["kind"]; count: number }[];
}

/**
 * Everything the export writes, in order.
 *
 * Meeting audio is not in here, and that is deliberate: the WAVs are the one
 * thing in this app measured in gigabytes, they are already on disk in the
 * meetings folder, and an export that quietly turned into 4 GB because a
 * project had six meetings in it would be a surprise in the wrong direction.
 * The index says so in as many words rather than leaving it to be noticed.
 */
export function exportPlan(
  project: Project,
  items: readonly ExportItem[],
  now = new Date(),
): ExportedPlan {
  const ops: ExportOp[] = [];
  const counts: { kind: Member["kind"]; count: number }[] = [];
  const lines: string[] = [`# ${project.name}`, ""];
  if (project.createdAt) lines.push(`Started ${readableDate(project.createdAt)}.`, "");
  lines.push(`Exported from MyRA on ${readableDate(now.toISOString())}.`, "");

  let anyMeeting = false;
  const imageNotes: string[] = [];

  for (const kind of ORDER) {
    const ofKind = items.filter((i) => i.member.kind === kind);
    if (!ofKind.length) continue;
    counts.push({ kind, count: ofKind.length });

    lines.push(`## ${HEADINGS[kind]}`, "");
    const used = new Set<string>();
    const folder = FOLDERS[kind];

    for (const item of ofKind) {
      const base = uniqueIn(used, fileName(item.title));
      const when = readableDate(item.at);
      const dated = when ? ` — ${when}` : "";

      if (item.text !== undefined) {
        const path = `${folder}/${base}.md`;
        ops.push({ op: "write", path, text: item.text });
        lines.push(`- [${item.title}](${path})${dated}`);
        continue;
      }

      if (item.dir) {
        const path = `${folder}/${base}`;
        ops.push({ op: "copyDir", path, from: item.dir });
        lines.push(`- [${item.title}](${path}/)${dated}${item.note ? ` · ${item.note}` : ""}`);
        continue;
      }

      if (item.files?.length) {
        if (kind === "image") {
          /* Flat, and named for the picture rather than foldered: an images
             folder somebody opens should show thumbnails, not a row of
             directories to click into. */
          for (const file of item.files) {
            const dot = file.name.lastIndexOf(".");
            const ext = dot > 0 ? file.name.slice(dot) : "";
            const path = `${folder}/${uniqueIn(used, `${base}${ext}`)}`;
            ops.push({ op: "copyFile", path, from: file.from });
            lines.push(`- [${item.title}](${path})${dated}`);
            imageNotes.push(`## ${item.title}`, "", item.note || "(no prompt recorded)", "");
          }
          continue;
        }
        anyMeeting ||= kind === "meeting";
        for (const file of item.files) {
          ops.push({ op: "copyFile", path: `${folder}/${base}/${file.name}`, from: file.from });
        }
        lines.push(`- [${item.title}](${folder}/${base}/)${dated}${item.note ? ` · ${item.note}` : ""}`);
        continue;
      }

      /* Resolved to nothing to copy -- a meeting recorded but never
         transcribed, an image whose file has gone. Listed anyway: a name in the
         index with no link is a truthful record of something that was in the
         project, and omitting it silently would make the export disagree with
         the app. */
      lines.push(`- ${item.title}${dated} — nothing written yet`);
    }
    lines.push("");
  }

  if (!counts.length) lines.push("This project is empty.", "");
  if (anyMeeting) {
    lines.push(
      "The meeting recordings themselves are not copied here — they are large, and they",
      "are still in your meetings folder. The notes and transcripts are.",
      "",
    );
  }

  if (imageNotes.length) {
    ops.push({
      op: "write",
      path: `${FOLDERS.image}/index.md`,
      text: ["# Images", "", "What each one was asked for.", "", ...imageNotes].join("\n"),
    });
  }

  /* Written last, so a crash halfway leaves no index claiming files that were
     never copied -- the done-marker rule the research pipeline and the image
     store both run on. */
  ops.push({ op: "write", path: "project.md", text: `${lines.join("\n").trimEnd()}\n` });
  return { ops, counts };
}

/* ------------------------------------------------------------------ *
 * A conversation, made readable                                       *
 * ------------------------------------------------------------------ */

interface RenderableMessage {
  role: string;
  content: string;
  tool_calls?: { function: { name: string } }[] | undefined;
}

/**
 * A stored conversation as something a person can read.
 *
 * Three things are deliberately left out.
 *
 * **The system prompt**, which is MyRA's rather than the user's, and is
 * several hundred words of instruction in front of every export.
 *
 * **Tool results**, which are the fetched pages and search results a turn
 * consumed. They are frequently longer than the whole conversation and would
 * make the export unreadable; what a person needs is that a search happened,
 * which the italic line records.
 *
 * **Reasoning**, which is not in the stored messages in the first place. MyRA
 * never writes a model's working-out into a session, and this is one more place
 * where that has to keep being true.
 */
export function renderSession(
  title: string,
  messages: readonly RenderableMessage[],
  at = "",
): string {
  const out: string[] = [`# ${title}`, ""];
  const when = readableDate(at);
  if (when) out.push(when, "");

  for (const message of messages) {
    if (message.role === "system" || message.role === "tool") continue;

    if (message.role === "user") {
      out.push("**You**", "", message.content.trim() || "*(nothing)*", "");
      continue;
    }
    if (message.role !== "assistant") continue;

    const text = message.content.trim();
    if (text) out.push("**MyRA**", "", text, "");
    for (const call of message.tool_calls ?? []) {
      out.push(`*(used ${call.function.name})*`, "");
    }
  }

  return `${out.join("\n").trimEnd()}\n`;
}
