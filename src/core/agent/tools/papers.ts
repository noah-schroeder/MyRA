/**
 * `project_papers` and `read_paper`: exploring the papers a project holds.
 *
 * The papers are the ones the person put there -- uploaded to the project, or
 * in the Zotero collections it is linked to -- and the model finds its way
 * around them the way a person skims a stack: the list, then the passages a
 * search points at, then the section worth reading. See
 * [sources/fulltext.ts](../../sources/fulltext.ts) for why that, rather than a
 * vector store, and [sources/search.ts](../../sources/search.ts) for the index.
 *
 * Both `safe`: they only read, and only files the person chose -- the host
 * checks every ref against the turn's own project, so a model cannot open a
 * paper by guessing a key outside it.
 *
 * Every line of paper text is indented in the reply. The renderer's citation
 * harvester reads `[n] Title` followed by an indented URL as a source, and a
 * paper's own numbered reference list is exactly that shape: unindented, a
 * reference list read here would quietly remap the conversation's [12] to
 * whatever the paper called [12].
 */

import { asUntrusted } from "../../research/html.ts";
import { cite } from "../../research/ledger.ts";
import { readsDocuments, readsLibrary, readResearchConfig } from "../../research/config.ts";
import { outline, readSpan, type FullText } from "../../sources/fulltext.ts";
import type { ToolDef } from "../registry.ts";

/** One paper as the tools list it. */
export interface PaperEntry {
  /** What the tools address it by: `source:<id>` for an upload, the Zotero key otherwise. */
  ref: string;
  title: string;
  authors: string;
  year: string;
  /** Where a citation marker resolves: a DOI or a URL. Absent means no number, author-year only. */
  link?: string | undefined;
  origin: "upload" | "zotero";
  /** Whether there is text to search or read, and if not, why. */
  readable: boolean;
  why?: string | undefined;
}

export interface PaperHit {
  paper: PaperEntry;
  /** 0 when the text had no page numbers. */
  page: number;
  section: string;
  text: string;
}

export interface PapersHost {
  /**
   * Whether this turn has papers to offer: the conversation is in a project
   * with uploads or linked collections. `outsideProject` is the Library rung's
   * case -- no project, but a Zotero key from search_library can still be read.
   */
  scope(): { project?: string | undefined; outsideProject?: boolean } | undefined;
  catalogue(): Promise<{ entries: PaperEntry[]; more: number }>;
  search(query: string, limit: number): Promise<{ hits: PaperHit[]; searched: number; skipped: PaperEntry[] }>;
  /** The paper's text, after checking `ref` is one this turn may open. */
  read(ref: string): Promise<{ paper: PaperEntry; text?: FullText | undefined; error?: string | undefined }>;
  /** How many tokens a reply may spend, from the window actually in use. */
  budget(): number;
}

let host: PapersHost | undefined;

export function setPapersHost(installed: PapersHost | undefined): void {
  host = installed;
}

function inProject(): boolean {
  return readsDocuments(readResearchConfig().mode) && Boolean(host?.scope()?.project);
}

function canRead(): boolean {
  const mode = readResearchConfig().mode;
  const scope = host?.scope();
  return Boolean(scope && ((scope.project && readsDocuments(mode)) || (scope.outsideProject && readsLibrary(mode))));
}

/** Two spaces in front of every line -- see the header on why paper text is never flush left. */
function indent(text: string, by = "    "): string {
  return text
    .split("\n")
    .map((line) => (line ? `${by}${line}` : ""))
    .join("\n");
}

function byline(p: PaperEntry): string {
  return [p.authors, p.year].filter(Boolean).join(" · ");
}

/**
 * A paper's head line and its link, in the shape the citation machinery
 * reads -- `[n] Title` then the URL indented beneath -- so a marker the model
 * writes becomes a working link. A paper with no link gets no number.
 */
function head(p: PaperEntry, n: number | undefined): string {
  const title = `${p.title}${byline(p) ? ` — ${byline(p)}` : ""}`;
  return n !== undefined && p.link ? `[${n}] ${title}\n    ${p.link}` : `— ${title}`;
}

export const projectPapersTool: ToolDef = {
  name: "project_papers",
  description:
    "Search the full text of the papers in this conversation's project -- the ones the user " +
    "uploaded to it and the PDFs in the Zotero collections linked to it. With a `query`, returns " +
    "the best-matching passages, each with its paper, page and section; use specific terms (a " +
    "construct, a method, an author) and try again with other words if the first search misses. " +
    "With no query, lists the papers. Read further with read_paper. Local only.",
  risk: "safe",
  enabled: inProject,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words to look for; leave out to list the papers" },
      limit: { type: "number", description: "How many passages (default 8, max 20)" },
    },
    additionalProperties: false,
  },
  async handler(params) {
    if (!host?.scope()?.project) {
      return { content: "This conversation is not in a project with papers, so there is nothing to search." };
    }
    const query = typeof params["query"] === "string" ? params["query"].trim() : "";

    if (!query) {
      const { entries, more } = await host.catalogue();
      if (!entries.length) {
        return { content: "This project has no papers yet. The user can add them on the project page, or link Zotero collections there." };
      }
      const lines = entries.map((p) => {
        const status = p.readable ? "" : ` (cannot be read: ${p.why ?? "no text"})`;
        return `- ${p.title}${byline(p) ? ` — ${byline(p)}` : ""} · paper "${p.ref}"${status}`;
      });
      return {
        content: [
          `${entries.length + more} paper(s) in this project${more ? `; the first ${entries.length} are listed` : ""}:`,
          "",
          ...lines,
          ...(more ? ["", `And ${more} more — search with a query to reach them.`] : []),
        ].join("\n"),
        detail: { count: entries.length + more },
      };
    }

    const rawLimit = Number(params["limit"]);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.round(rawLimit), 1), 20) : 8;
    const { hits, searched, skipped } = await host.search(query, limit);

    /* Numbered from the shared ledger, one number per PAPER, so two passages
       of one paper carry the same marker and a paper also found by
       search_library keeps the number it already has. */
    const links = [...new Set(hits.flatMap((h) => (h.paper.link ? [h.paper.link] : [])))];
    const issued = cite(links);
    const numbers = new Map(links.map((link, i) => [link, issued[i]!]));

    const notes: string[] = [];
    if (skipped.length) {
      notes.push(
        `${skipped.length} paper(s) could not be searched: ${skipped
          .slice(0, 6)
          .map((p) => `“${p.title}” (${p.why ?? "no text"})`)
          .join("; ")}${skipped.length > 6 ? "; …" : ""}. Say so if it matters.`,
      );
    }
    if (!hits.length) {
      return {
        content:
          `No passage in the ${searched} searchable paper(s) of this project matches ${JSON.stringify(query)}. ` +
          `Try other words, or list the papers with no query.${notes.length ? `\n\n${notes.join("\n")}` : ""}`,
        detail: { count: 0 },
      };
    }

    const blocks = hits.map((h) => {
      const n = h.paper.link ? numbers.get(h.paper.link) : undefined;
      const where = [h.page ? `p. ${h.page}` : "no page number in this copy", h.section].filter(Boolean).join(" · ");
      return [head(h.paper, n), `    paper "${h.paper.ref}" · ${where}`, indent(h.text, "    │ ")].join("\n");
    });
    const unlinked = hits.some((h) => !h.paper.link);
    const body = [
      `${hits.length} passage(s) from ${searched} searchable paper(s) in this project, best first.`,
      "Cite a paper by its [n] and give the page in your prose, e.g. \"(p. 7)\".",
      unlinked ? "A paper with no DOI or URL has no number; refer to it by author and year." : "",
      "",
      blocks.join("\n\n"),
    ]
      .filter((line, i) => line || i === 3)
      .join("\n");
    return {
      content: `${asUntrusted("this project's papers", body, "is from papers in the user's project")}${
        notes.length ? `\n\n${notes.join("\n")}` : ""
      }`,
      detail: { count: hits.length, papers: [...new Set(hits.map((h) => h.paper.ref))] },
    };
  },
};

export const readPaperTool: ToolDef = {
  name: "read_paper",
  description:
    "Read one paper from this conversation's project, or a Zotero item search_library returned: " +
    "its outline, then the section or page you ask for. `paper` is the id project_papers or " +
    "search_library gave. Ask for a `section` by its heading (\"Methods\") or a `page`; with " +
    "neither, it starts at the beginning. Long papers are read in parts -- the reply says where " +
    "to continue.",
  risk: "safe",
  enabled: canRead,
  parameters: {
    type: "object",
    properties: {
      paper: { type: "string", description: "The paper's id: \"source:…\" or a Zotero key" },
      section: { type: "string", description: "A heading from the outline, e.g. \"Methods\"" },
      page: { type: "number", description: "A page to start from" },
    },
    required: ["paper"],
    additionalProperties: false,
  },
  async handler(params) {
    if (!host?.scope()) return { content: "There are no papers this conversation can open." };
    const ref = typeof params["paper"] === "string" ? params["paper"].trim().replace(/^"|"$/g, "") : "";
    if (!ref) return { content: "`paper` is needed: the id project_papers or search_library gave for it." };
    const section = typeof params["section"] === "string" ? params["section"] : undefined;
    const rawPage = Number(params["page"]);
    const page = Number.isFinite(rawPage) && params["page"] !== undefined ? Math.round(rawPage) : undefined;

    const { paper, text, error } = await host.read(ref);
    if (!text) {
      return { content: `“${paper.title}” cannot be read: ${error ?? "it has no text"}.` };
    }

    const span = readSpan(text, { section, page }, host.budget());
    const shape = outline(text);
    if (span.missing) {
      return {
        content: `“${paper.title}” has no ${JSON.stringify(span.missing)}. Its outline: ${shape}. Ask for one of those, or a page.`,
      };
    }
    const n = paper.link ? cite([paper.link])[0] : undefined;
    const body = [
      head(paper, n),
      `    paper "${paper.ref}" · ${shape}`,
      text.paged ? "" : "    This copy has no page numbers (it is Zotero's index text); do not cite a page from it.",
      "",
      indent(span.text),
      "",
      span.continuesAt
        ? `Continues on page ${span.continuesAt} — call read_paper with page ${span.continuesAt} to read on.`
        : "End of what was asked for.",
    ]
      .filter((line, i, all) => line !== "" || (all[i - 1] ?? "") !== "")
      .join("\n");
    return {
      content: asUntrusted(paper.title, body, "is from a paper in the user's project"),
      detail: { paper: paper.ref, ...(span.continuesAt ? { continuesAt: span.continuesAt } : {}) },
    };
  },
};

export const PAPER_TOOL_DEFS: ToolDef[] = [projectPapersTool, readPaperTool];
