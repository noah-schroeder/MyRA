/**
 * A file dropped into the chat: the id shape, and what it costs to send.
 *
 * Three kinds, three fates. A document's text is extracted once and inlined
 * into the message as ordinary words -- see main/index.ts, which wraps it in
 * the same UNTRUSTED CONTENT markers `read_document` uses. An image cannot be
 * inlined as text, so the message keeps only this small reference and the
 * bytes live on disk; `expandImages` below is where a reference turns back
 * into something a vision model can read, and it does so only at the last
 * possible moment, inside `buildRequest`. A `data` attachment -- a pasted or
 * dropped table -- is kept exactly like an image: bytes on disk, a reference
 * in the message. It is never expanded into the wire request at all, which is
 * the point (see tools/table.ts's header): the model reaches the numbers only
 * by calling a tool with the attachment's id, never by having them typed into
 * its own context, which is the one route a transcription error could travel.
 *
 * `ChatMessage.content` is never an array. Widening it would have meant
 * teaching every reader of a stored conversation -- the title, the export
 * renderer, compaction's token estimate -- to handle a shape it will only see
 * once in a very long while, for no benefit: none of them need to see the
 * image, only the model does. Keeping `content: string` everywhere except the
 * one place that builds the wire request is what makes that whole class of
 * bug unrepresentable rather than merely avoided.
 */

import { asUntrusted } from "../research/html.ts";

export type AttachmentKind = "image" | "document" | "data";

/** What a message carries, as a reference -- never the bytes and never the text. */
export interface Attachment {
  id: string;
  kind: AttachmentKind;
  name: string;
  mime?: string;
  /** Documents only, for the chip. */
  words?: number;
  /** Data attachments only, for the chip and for the shape line the model
   *  reads instead of the numbers themselves. */
  rows?: number;
  columns?: string[];
}

function randomId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

export function attachmentId(): string {
  return randomId();
}

/**
 * An attachment id, refused if it is anything but one.
 *
 * The same guard `assertPaperId`, `assertImageId` and `assertRunId` are, for
 * the same reason: this comes back from a sandboxed window to be joined onto
 * a path and then read.
 */
export function assertAttachmentId(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") {
    throw new Error(`no attachment named ${JSON.stringify(id)}`);
  }
  return id;
}

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image_url";
  image_url: { url: string };
}

export type ContentPart = TextPart | ImagePart;

/**
 * A message's content, expanded to the OpenAI content-part shape when it
 * carries an image -- and left as plain text otherwise, which is every
 * message in every conversation that has never had an image dropped into it.
 *
 * `resolve` is synchronous on purpose: this runs inside `buildRequest`, which
 * is pure so it can be asserted without a server, and an async file read
 * cannot happen inside it. The caller resolves every image to a data URI
 * ahead of time and hands over a plain lookup.
 *
 * An image whose id no longer resolves -- the file was removed, or the
 * reference is stale -- is dropped rather than failing the whole request: the
 * text still has a place to go, and a missing attachment is not a reason to
 * refuse a question that may not even be about it.
 */
export function expandImages(
  content: string,
  attachments: readonly Attachment[] | undefined,
  resolve: (id: string) => string | undefined,
): string | ContentPart[] {
  const images = (attachments ?? []).filter((a) => a.kind === "image");
  if (!images.length) return content;

  const parts: ContentPart[] = [{ type: "text", text: content }];
  for (const image of images) {
    const url = resolve(image.id);
    if (url) parts.push({ type: "image_url", image_url: { url } });
  }
  // None of them resolved: plain text, so the message is not sent with an
  // empty gesture at an image that is not there.
  return parts.length > 1 ? parts : content;
}

/**
 * A rough token cost for an image, since `estimateTokens` counts characters
 * and an image has none.
 *
 * Not a measurement -- vision encoders vary, and this app does not know which
 * one the loaded model uses -- but zero would be worse: a conversation with
 * several images attached would look like it has room it does not have, and
 * compaction would never trigger until the request itself was refused.
 * Deliberately generous, in the direction that trips compaction a little
 * early rather than a lot late.
 */
export const IMAGE_TOKEN_ESTIMATE = 1200;

/**
 * A user message's own text, with a dropped document's extracted content and
 * a pasted table's shape line folded in ahead of it as ordinary words.
 *
 * Both are wrapped as untrusted, and for the same reason: a colleague's
 * export or a downloaded dataset is somebody else's writing, exactly as a
 * dropped document is, and its column headers are exactly the kind of place
 * a pasted prompt-injection payload would sit -- there is nothing about
 * arriving as a table's header row rather than a paragraph that makes it
 * safer to read as an instruction. The shape line names columns and a row
 * count only, never a value; the numbers themselves reach a tool exclusively
 * through the attachment's id (see tools/table.ts's header).
 */
export function composeMessageContent(
  text: string,
  documents: readonly { name: string; text: string }[],
  data: readonly { id: string; name: string; rows: number; columns: readonly string[] }[],
): string {
  const documentText = documents
    .map((d) => asUntrusted(d.name, d.text, "is a document the user attached to this message"))
    .join("\n\n");
  const dataText = data
    .map((d) =>
      asUntrusted(
        d.name,
        `[data ${d.id}: "${d.name}" -- ${d.columns.length} columns (${d.columns.join(", ")}), ${d.rows} rows]`,
        "describes a table the user attached to this message",
      ),
    )
    .join("\n\n");
  return [documentText, dataText, text].filter((s) => s).join("\n\n").trim();
}
