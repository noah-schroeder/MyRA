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
import { untrusted } from "./research.ts";

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

export const writeDocumentTool: ToolDef = {
  name: "write_document",
  description:
    "Write a document into the user's documents folder. Content is Markdown; give a format to " +
    "convert it. Returns the path written. Cannot write anywhere else.",
  risk: "write",
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
      return { content: `Wrote ${name} (${bytes} bytes).`, detail: { path: abs, bytes } };
    }

    // Markdown goes to disk first: the converters read files, not stdin, and a
    // source left behind is also what makes a failed conversion diagnosable.
    const source = `${abs.replace(/\.[^./]*$/, "")}.md`;
    await writeText(source, content);
    const produced = await convert(source, format, dirname(abs));
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
    return { content: untrusted(name, text), detail: { path: abs, chars: text.length } };
  },
};

export const convertDocumentTool: ToolDef = {
  name: "convert_document",
  description:
    "Convert a document already in the documents folder into another format. " +
    "Writes a new file beside it and never replaces the original.",
  risk: "write",
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

export const DOCUMENT_TOOL_DEFS: ToolDef[] = [
  writeDocumentTool,
  readDocumentTool,
  convertDocumentTool,
];
