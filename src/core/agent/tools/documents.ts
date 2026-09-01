/**
 * Reading and writing documents, jailed.
 *
 * Every path the model supplies passes through safeRelativePath and then a
 * realpath check against the jail root, on every call. v1's jail held against
 * six attacks -- traversal, an absolute path, a normalisation-hidden climb, and
 * two symlink escapes -- and the tests that established that came across with
 * it. The rule to preserve is that resolution happens after normalisation and
 * after symlinks, never before.
 */

import { realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  FORMAT_NAMES, isReadable, resolveFormat, safeRelativePath, slugName,
} from "../../documents/formats.ts";
import {
  DocsError, convert, documentsDir, exists, readAsText, writeText,
} from "../../documents/office.ts";
import type { ToolDef } from "../registry.ts";
import { asUntrusted } from "../../research/html.ts";
import { readResearchConfig } from "../../research/config.ts";
import { runDraft, type DraftUi } from "../../documents/draft.ts";
import type { Outline } from "../../documents/outline.ts";

/**
 * Whether the document tools go out in the schema at all.
 *
 * These were the last three tools left standing at "off", on the reasoning that
 * they are local and jailed so nothing could leak through them. What leaked was
 * attention, not data: a 2.6B model greeted with "hi" has three things it is
 * able to call, and calls them. Instructing it not to is a request that a small
 * model is free to ignore; leaving the tools out of the request is a guarantee,
 * because the wire format omits `tools` entirely when the list is empty and
 * there is then nothing for the model to name.
 *
 * That is why this is a gate and not another paragraph in the system prompt.
 */
function available(): boolean {
  return readResearchConfig().mode !== "off";
}

/**
 * Resolve a model-supplied name inside the jail.
 *
 * Two checks, because either alone is insufficient. safeRelativePath rejects
 * the textual attacks -- `..`, a leading `/`, a NUL. The realpath comparison
 * catches the ones text cannot see: a symlink inside the jail pointing out of
 * it resolves to a path outside, and only asking the filesystem reveals that.
 *
 * The realpath is taken of the nearest EXISTING ancestor, because the file
 * being written usually does not exist yet and realpath would fail on it.
 */
export async function resolveInJail(root: string, name: string): Promise<string> {
  // Refused rather than reinterpreted. safeRelativePath strips a leading slash,
  // which is safe -- the result still lands inside the jail -- but it turns a
  // request for /etc/passwd into a real file at <jail>/etc/passwd, and a
  // phantom etc/ directory appearing in someone's documents folder is nobody's
  // intent. At the tool boundary a confused path should be an error the model
  // can see, not a silent relocation.
  if (name.trim().startsWith("/")) {
    throw new DocsError(`${JSON.stringify(name)} is an absolute path; give a name inside the documents folder`);
  }
  const rel = safeRelativePath(name);
  if (!rel) throw new DocsError(`${JSON.stringify(name)} is not a name inside the documents folder`);

  const jail = await realpath(root).catch(() => resolve(root));
  const target = resolve(jail, rel);

  let probe = target;
  for (;;) {
    const real = await realpath(probe).catch(() => undefined);
    if (real !== undefined) {
      const realTarget = probe === target ? real : join(real, target.slice(probe.length + 1));
      if (realTarget !== jail && !realTarget.startsWith(jail + sep)) {
        throw new DocsError(`${name} resolves outside the documents folder`);
      }
      return realTarget;
    }
    const parent = dirname(probe);
    if (parent === probe) throw new DocsError(`${name} cannot be resolved`);
    probe = parent;
  }
}

/**
 * A document as it stands, for anything that wants to show it.
 *
 * Pushed rather than polled, and carrying the text rather than only the path,
 * because the reason this exists is the draft flow: it saves after every
 * section, and a panel that had to re-read the file would be racing the writer
 * for it. `final` is false for those intermediate saves.
 */
export interface DocumentUpdate {
  /** Absolute path of the file that was written. */
  path: string;
  /** Its name relative to the documents folder, which is what a person calls it. */
  name: string;
  /** The Markdown source. For a converted format this is what it was made from. */
  markdown: string;
  final: boolean;
}

let watcher: ((doc: DocumentUpdate) => void) | undefined;

/**
 * Left uninstalled, writing a document simply tells nobody -- which is exactly
 * what happened before this existed, and is a fine state for a headless test.
 */
export function setDocumentWatcher(fn: ((doc: DocumentUpdate) => void) | undefined): void {
  watcher = fn;
}

function announce(path: string, markdown: string, final: boolean): void {
  const dir = documentsDir();
  watcher?.({
    path,
    name: path.startsWith(dir + sep) ? path.slice(dir.length + 1) : path,
    markdown,
    final,
  });
}

export const writeDocumentTool: ToolDef = {
  name: "write_document",
  description:
    "Write a document into the user's documents folder. Content is Markdown; give a format to " +
    "convert it. Returns the path written. Cannot write anywhere else.",
  risk: "write",
  enabled: available,
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Filename, relative to the documents folder" },
      title: { type: "string", description: "Used to name the file when `name` is omitted" },
      content: { type: "string", description: "The document body, in Markdown" },
      format: { type: "string", description: `One of: ${FORMAT_NAMES.join(", ")}. Defaults to md.` },
    },
    required: ["content"],
    additionalProperties: false,
  },
  async handler(params) {
    const content = String(params["content"] ?? "");
    if (!content.trim()) throw new DocsError("write_document was given no content");

    const format = resolveFormat(String(params["format"] ?? "md"));
    if (!format) {
      throw new DocsError(`Unknown format. Choose one of: ${FORMAT_NAMES.join(", ")}`);
    }

    const given = String(params["name"] ?? "").trim();
    const name = given || slugName(String(params["title"] ?? "document"), format.ext);
    const abs = await resolveInJail(documentsDir(), name);

    if (format.ext === "md") {
      const bytes = await writeText(abs, content);
      announce(abs, content, true);
      return { content: `Wrote ${name} (${bytes} bytes).`, detail: { path: abs, bytes } };
    }

    // Markdown goes to disk first: the converters read files, not stdin, and a
    // source left behind is also what makes a failed conversion diagnosable.
    const source = `${abs.replace(/\.[^./]*$/, "")}.md`;
    await writeText(source, content);
    const produced = await convert(source, format, dirname(abs));
    // The produced file is what the user has; the Markdown is what can be
    // shown. A .docx is not readable text, so the panel gets its source.
    announce(produced, content, true);
    return {
      content: `Wrote ${produced.slice(documentsDir().length + 1)} as ${format.label}.`,
      detail: { path: produced, source },
    };
  },
};

export const readDocumentTool: ToolDef = {
  name: "read_document",
  description:
    "Read a document from the user's documents folder as text. Handles PDF, Word, " +
    "OpenDocument, HTML and Markdown. Cannot read anywhere else, and cannot open a URL.",
  risk: "safe",
  enabled: available,
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Filename, relative to the documents folder" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  async handler(params) {
    const name = String(params["name"] ?? "");
    const abs = await resolveInJail(documentsDir(), name);
    if (!(await exists(abs))) throw new DocsError(`${name} does not exist`);
    if (!isReadable(abs)) throw new DocsError(`${name} is not a document this can read as text`);

    const text = await readAsText(abs);
    // A document can have arrived from the open web -- a downloaded preprint is
    // the normal case here -- so it is labelled as data, exactly like a page.
    return { content: asUntrusted(name, text), detail: { path: abs, chars: text.length } };
  },
};

export const convertDocumentTool: ToolDef = {
  name: "convert_document",
  description:
    "Convert a document already in the documents folder into another format. " +
    "Writes a new file beside it and never replaces the original.",
  risk: "write",
  enabled: available,
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Filename, relative to the documents folder" },
      format: { type: "string", description: `One of: ${FORMAT_NAMES.join(", ")}` },
    },
    required: ["name", "format"],
    additionalProperties: false,
  },
  async handler(params) {
    const name = String(params["name"] ?? "");
    const format = resolveFormat(String(params["format"] ?? ""));
    if (!format) throw new DocsError(`Unknown format. Choose one of: ${FORMAT_NAMES.join(", ")}`);

    const abs = await resolveInJail(documentsDir(), name);
    if (!(await exists(abs))) throw new DocsError(`${name} does not exist`);

    const produced = await convert(abs, format, dirname(abs));
    return {
      content: `Converted ${name} to ${format.label}: ${produced.slice(documentsDir().length + 1)}`,
      detail: { path: produced },
    };
  },
};

/* ------------------------------------------------------------------ *
 * Drafting                                                            *
 * ------------------------------------------------------------------ */

/**
 * What the draft flow needs from the app: a model, and a way to show the
 * outline for approval.
 *
 * Left uninstalled the tool REFUSES rather than degrading to a one-shot write.
 * Silently skipping the approval would turn the one stage that makes this
 * different from write_document into a stage that sometimes happens -- and the
 * user would find out by receiving a finished document they never agreed to.
 */
export interface DraftHost {
  /** Read per call, not captured: the loaded model changes under the app. */
  model: () => string;
  ui: DraftUi;
  onProgress?: (note: string) => void;
}

let draftHost: DraftHost | undefined;

export function setDraftHost(installed: DraftHost | undefined): void {
  draftHost = installed;
}

/**
 * Write the draft into the documents folder, converting on the last pass.
 *
 * The intermediate saves stay Markdown whatever the target format is. Running
 * pandoc after every section would spawn a process a dozen times to produce a
 * .docx nobody is reading yet, and the point of saving early is crash
 * insurance, which a .md satisfies exactly as well.
 */
async function saveDraft(
  outline: Outline,
  markdown: string,
  final: boolean,
): Promise<string> {
  const format = resolveFormat(outline.format) ?? resolveFormat("md")!;
  const abs = await resolveInJail(documentsDir(), outline.filename);
  const source = `${abs.replace(/\.[^./]*$/, "")}.md`;

  await writeText(source, markdown);
  if (!final || format.ext === "md") {
    announce(source, markdown, final);
    return source;
  }
  const produced = await convert(source, format, dirname(abs));
  announce(produced, markdown, true);
  return produced;
}

export const draftDocumentTool: ToolDef = {
  name: "draft_document",
  description:
    "Plan and write a document that has several sections — a report, a review, a chapter, " +
    "a structured memo. Proposes an outline for the user to approve and edit, then writes " +
    "each section separately and saves as it goes. Use write_document instead when the " +
    "content is short enough to write in one go, or when the user gave you the text.",
  risk: "write",
  enabled: available,
  parameters: {
    type: "object",
    properties: {
      request: {
        type: "string",
        description:
          "What the document should be, in full: subject, purpose, audience and any " +
          "structure the user asked for. This is all the planner sees.",
      },
      format: { type: "string", description: `One of: ${FORMAT_NAMES.join(", ")}. Defaults to md.` },
    },
    required: ["request"],
    additionalProperties: false,
  },
  async handler(params, ctx) {
    if (!draftHost) {
      throw new DocsError(
        "Drafting is not available: the app has not attached a draft host. " +
          "This is a wiring fault, not something to work around.",
      );
    }
    const request = String(params["request"] ?? "").trim();
    if (!request) throw new DocsError("draft_document was given no request");

    const formatName = String(params["format"] ?? "md");
    if (!resolveFormat(formatName)) {
      throw new DocsError(`Unknown format. Choose one of: ${FORMAT_NAMES.join(", ")}`);
    }

    const result = await runDraft({
      request,
      model: draftHost.model(),
      // Threaded through, not merely validated: the format reaches the outline,
      // which names the file and decides whether the last save runs a
      // conversion. Checked above and then dropped, "write it as a docx" would
      // have produced a .md and said nothing about it.
      format: formatName,
      ui: draftHost.ui,
      save: (markdown, opts) => saveDraft(opts.outline, markdown, opts.final),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      onProgress: (note) => {
        ctx.onUpdate?.(note);
        draftHost?.onProgress?.(note);
      },
    });

    const rel = result.path.slice(documentsDir().length + 1);
    /*
     * The warning leads, because the model decides what the user hears.
     *
     * Put after "wrote 3 sections, 542 words" it reads as a footnote to a
     * success and gets summarised away as "done!". Nothing in this flow
     * searched, so a citation in the text is invented -- and a fabricated
     * reference in an academic document is the one failure the user cannot be
     * left to discover on their own, weeks later, in a draft they have since
     * sent to someone.
     */
    const warning = result.invented.length
      ? `WARNING — this document contains invented citations and they must be reported to the ` +
        `user before anything else. Nothing here searched any literature, so every reference ` +
        `below was made up by the model and none of them are real: ` +
        result.invented
          .map((s) => `under "${s.heading}": ${s.found.join(", ")}`)
          .join("; ") +
        `. Tell the user which sections are affected and that they must remove or replace ` +
        `these before using the document. `
      : "";

    return {
      content:
        warning +
        `Wrote ${rel}: ${result.outline.sections.length} sections, ` +
        `${result.words.toLocaleString()} words. Tell the user it is saved and where.`,
      detail: {
        path: result.path,
        sections: result.outline.sections.length,
        words: result.words,
        ...(result.invented.length ? { invented: result.invented } : {}),
      },
    };
  },
};

export const DOCUMENT_TOOL_DEFS: ToolDef[] = [
  writeDocumentTool,
  readDocumentTool,
  convertDocumentTool,
  draftDocumentTool,
];
