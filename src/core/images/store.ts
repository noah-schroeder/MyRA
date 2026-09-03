/**
 * Generated images on disk, and what is known about each one.
 *
 * The pure half: what a file is called, what is written beside it, and what
 * counts as a finished generation. The half that touches a disk lives in
 * main/images.ts, so this is testable with no Electron and no endpoint.
 *
 * TWO RULES, and they are the same two the research pipeline runs on.
 *
 *   1. **The sidecar is the done-marker.** The image is written first, the JSON
 *      beside it second, and a listing enumerates sidecars. An interrupted
 *      generation therefore leaves an orphan .png that is never shown, rather
 *      than a half-written picture that is listed as if it were finished.
 *   2. **The prompt becomes a filename, so it is slugged.** This is user text
 *      being joined onto a path. `assertImageId` is the same guard
 *      `assertRunId` is, and for the same reason: the id comes back from the
 *      renderer to be deleted, revealed and re-read.
 *
 * A flat pair rather than a directory each, which is where this departs from
 * meetings/store.ts. A meeting has six artifacts and earns a folder; an image
 * has two, and this folder is one the user is meant to open and browse -- a
 * few hundred directories holding one picture apiece would make it unusable in
 * exactly the file manager it is designed to be seen in.
 */

/** Everything written beside an image, and everything the gallery shows. */
export interface ImageRecord {
  id: string;
  /** What the user typed, before any preset was folded in. */
  prompt: string;
  /** What was actually sent, scaffold and all. */
  sentPrompt: string;
  /** What the user typed in the avoid box, before the preset's terms. */
  negative: string;
  /** What was actually sent to avoid. */
  sentNegative: string;
  size: string;
  /** The model reference, so "what made this" survives a settings change. */
  model: string;
  /** Which preset was on, if any. */
  preset?: string;
  /** True when making this sent the prompt off the machine. */
  external: boolean;
  at: string;
  file: string;
  mime: string;
  bytes: number;
  /** How long it took, for a page that can say "about a minute" next time. */
  seconds?: number;
}

export const SIDECAR_EXT = ".json";

/**
 * A short, human-legible, filesystem-safe id: date, time, and a prompt slug.
 *
 * The clock is the LOCAL one, not UTC. This name is read in a file manager,
 * next to the modification time that manager prints — and `toISOString` put
 * `20260903-1710` on a picture the column beside it said was made at 10:10.
 * A timestamp in a filename is only useful if it is the same one the person
 * looking at it is on.
 */
export function imageId(prompt: string, now = new Date(), salt = ""): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}` +
    `-${two(now.getHours())}${two(now.getMinutes())}`;
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 6)
    .join("-")
    .slice(0, 60);
  return `${stamp}-${slug || "image"}${salt ? `-${salt}` : ""}`;
}

/**
 * An image id, refused if it is anything but one.
 *
 * These arrive back from the renderer to be joined onto the images root and
 * then deleted, revealed in a file manager, or read and handed to the window.
 * Checking costs a regex.
 */
export function assertImageId(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") {
    throw new Error(`no image named ${JSON.stringify(id)}`);
  }
  return id;
}

export function sidecarName(id: string): string {
  return `${assertImageId(id)}${SIDECAR_EXT}`;
}

/** The id a sidecar filename belongs to, or nothing if it is not one. */
export function idOfSidecar(filename: string): string | undefined {
  if (!filename.endsWith(SIDECAR_EXT)) return undefined;
  const id = filename.slice(0, -SIDECAR_EXT.length);
  return /^[A-Za-z0-9._-]+$/.test(id) && id !== "." && id !== ".." ? id : undefined;
}

/**
 * A record read back off disk, rebuilt field by field.
 *
 * The same discipline the settings parsers get. These files sit in a folder the
 * user is invited to open, so one of them will eventually be edited, truncated
 * by a full disk, or synced half-written -- and a gallery that throws on the
 * fifth of two hundred images is worse than one that skips it.
 */
export function parseRecord(raw: unknown, id: string): ImageRecord | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const text = (key: string, fallback = ""): string =>
    typeof row[key] === "string" ? (row[key] as string) : fallback;
  const file = text("file");
  if (!file || !/^[A-Za-z0-9._-]+$/.test(file)) return undefined;
  const seconds = Number(row["seconds"]);
  return {
    id,
    prompt: text("prompt"),
    sentPrompt: text("sentPrompt", text("prompt")),
    negative: text("negative"),
    sentNegative: text("sentNegative", text("negative")),
    size: text("size"),
    model: text("model"),
    ...(text("preset") ? { preset: text("preset") } : {}),
    external: row["external"] === true,
    at: text("at"),
    file,
    mime: text("mime", "image/png"),
    bytes: Number.isFinite(Number(row["bytes"])) ? Number(row["bytes"]) : 0,
    ...(Number.isFinite(seconds) && seconds >= 0 ? { seconds } : {}),
  };
}

/** Newest first, which is the order a gallery of these wants to be read in. */
export function byNewest(a: ImageRecord, b: ImageRecord): number {
  return b.at.localeCompare(a.at) || b.id.localeCompare(a.id);
}
