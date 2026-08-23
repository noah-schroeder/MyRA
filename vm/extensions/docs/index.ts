/**
 * Document drafting, entirely inside the VM.
 *
 * The host deliberately has no document verb. The agent drafts here, in its own
 * workspace, and the user pulls a finished file across with a native file
 * dialog when they want it. So there is no "save to the user's Desktop" tool in
 * this file, and its absence is the design rather than an omission.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { relative } from "node:path";
import {
  FORMAT_NAMES, isReadable, outputName, resolveFormat, safeRelativePath, slugName,
} from "./formats.ts";
import {
  convert, documentsDir, DocsError, exists, inWorkspace, readAsText, writeText,
} from "./office.ts";

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function fail(err: unknown) {
  const message = err instanceof DocsError ? err.message : ((err as Error).message ?? String(err));
  return textResult(`That did not work: ${message}`, { error: true });
}

/** Where a file sits, said the way the user will see it in the app. */
function shown(abs: string): string {
  return relative(documentsDir(), abs) || abs;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "write_document",
    label: "Write document",
    description:
      "Write a document and, if asked for a format other than Markdown, convert it. " +
      "Give the body as Markdown -- headings, lists, tables and emphasis all survive the " +
      "conversion into Word, OpenDocument and PDF. The file lands in the user's Karen " +
      "documents folder; they save it wherever they want from the app.",
    promptSnippet: "Draft a document",
    promptGuidelines: [
      "Write the whole document. A model that outlines and offers to continue wastes a turn.",
      "Markdown in, any format out: never hand-write .docx XML or PDF syntax.",
      "Say the filename back to the user -- they need it to find the file.",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "Used for the filename when name is not given." }),
      content: Type.String({ description: "The document body, as Markdown." }),
      format: Type.Optional(
        Type.String({ description: `One of: ${FORMAT_NAMES.join(", ")}. Defaults to docx.` }),
      ),
      name: Type.Optional(
        Type.String({ description: "Filename, optionally in a subfolder. No leading slash." }),
      ),
    }),
    execute: async (input: Record<string, unknown>) => {
      try {
        const format = resolveFormat(String(input["format"] ?? "docx"));
        if (!format) {
          return textResult(
            `I cannot write ${String(input["format"])}. Available: ${FORMAT_NAMES.join(", ")}.`,
            { error: true },
          );
        }

        const title = String(input["title"] ?? "").trim();
        const content = String(input["content"] ?? "");
        if (!content.trim()) return textResult("There was no content to write.", { error: true });

        const wanted = input["name"] ? safeRelativePath(String(input["name"])) : undefined;
        if (input["name"] && !wanted) {
          return textResult(
            `"${String(input["name"])}" is not a name I can write to. Use a plain filename.`,
            { error: true },
          );
        }

        // Markdown is written directly; anything else is written as Markdown
        // first and converted, because that is the path LibreOffice reads best.
        const stem = wanted ?? slugName(title || "document", format.ext);
        const mdRel = stem.replace(/\.[^./]+$/, "") + ".md";
        const mdAbs = inWorkspace(mdRel);
        const bytes = await writeText(mdAbs, content.endsWith("\n") ? content : `${content}\n`);

        if (format.ext === "md") {
          return textResult(`Wrote ${shown(mdAbs)} (${bytes} bytes).`, { path: mdAbs, format: "md" });
        }

        const outDir = inWorkspace(mdRel.includes("/") ? mdRel.slice(0, mdRel.lastIndexOf("/")) : ".");
        const produced = await convert(mdAbs, format, outDir);
        return textResult(
          `Wrote ${shown(produced)} as ${format.label}. The Markdown source is at ` +
            `${shown(mdAbs)} if it needs editing.`,
          { path: produced, source: mdAbs, format: format.ext },
        );
      } catch (err) {
        return fail(err);
      }
    },
  });

  pi.registerTool({
    name: "convert_document",
    label: "Convert document",
    description:
      "Convert a document in the Karen documents folder into another format. The original " +
      "is never modified and never replaced.",
    promptSnippet: "Convert a document",
    promptGuidelines: [
      "Paths are relative to the documents folder. An absolute path will be refused.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "The document to convert, relative to the documents folder." }),
      format: Type.String({ description: `One of: ${FORMAT_NAMES.join(", ")}.` }),
    }),
    execute: async (input: Record<string, unknown>) => {
      try {
        const rel = safeRelativePath(String(input["path"] ?? ""));
        if (!rel) return textResult("That path is not inside the documents folder.", { error: true });

        const format = resolveFormat(String(input["format"] ?? ""));
        if (!format) {
          return textResult(
            `I cannot convert to ${String(input["format"])}. Available: ${FORMAT_NAMES.join(", ")}.`,
            { error: true },
          );
        }

        const abs = inWorkspace(rel);
        if (!(await exists(abs))) return textResult(`There is no file at ${rel}.`, { error: true });
        if (outputName(abs, format) === abs.slice(abs.lastIndexOf("/") + 1)) {
          return textResult(`${rel} is already ${format.label}.`, { path: abs });
        }

        const outDir = inWorkspace(rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".");
        const produced = await convert(abs, format, outDir);
        return textResult(`Converted ${rel} to ${shown(produced)}.`, { path: produced, format: format.ext });
      } catch (err) {
        return fail(err);
      }
    },
  });

  pi.registerTool({
    name: "read_document",
    label: "Read document",
    description:
      "Read a Word, OpenDocument, PDF, HTML or Markdown file as text. Use this rather than " +
      "`read` for anything that is not plain text -- `read` returns the compressed bytes of a " +
      ".docx, which are of no use to anyone.",
    promptSnippet: "Read a document",
    promptGuidelines: [
      "Formatted documents come back as Markdown, so headings and lists are still visible.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Relative to the documents folder." }),
      max_chars: Type.Optional(Type.Number({ description: "Truncate after this many characters." })),
    }),
    execute: async (input: Record<string, unknown>) => {
      try {
        const rel = safeRelativePath(String(input["path"] ?? ""));
        if (!rel) return textResult("That path is not inside the documents folder.", { error: true });

        const abs = inWorkspace(rel);
        if (!(await exists(abs))) return textResult(`There is no file at ${rel}.`, { error: true });
        if (!isReadable(abs)) {
          return textResult(`I do not know how to read text out of ${rel}.`, { error: true });
        }

        const text = await readAsText(abs);
        const limit = Number(input["max_chars"] ?? 60_000);
        const clipped = text.length > limit;
        return textResult(clipped ? `${text.slice(0, limit)}\n\n[truncated]` : text, {
          path: abs,
          chars: text.length,
          truncated: clipped,
        });
      } catch (err) {
        return fail(err);
      }
    },
  });
}
