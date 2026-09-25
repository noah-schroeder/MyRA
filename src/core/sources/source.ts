/**
 * A paper somebody put into a project: the record beside the file.
 *
 * The seventh kind of project member, and the one kind that is not something
 * MyRA made -- which is why its metadata is a guess the page lets the person
 * correct, not a fact. The title is read off the first page, the DOI off the
 * first two; nothing is looked up, because a PDF dropped into a project must
 * not become a network request about it.
 *
 * Kept as a directory under the sources root, the image store's rule applied:
 * the text and the file are written first and `source.json` last, so a
 * listing that reads only directories holding `source.json` can never show a
 * paper whose text is not there yet. Pure: no disk here --
 * [store.ts](./store.ts) owns that.
 */

/** What became of the attempt to read the text. Only "ok" is searchable. */
export type TextStatus = "ok" | "scanned" | "failed";

export interface Source {
  id: string;
  title: string;
  /** Free text as the person would write it: "Venkatesh, Morris, Davis". */
  authors: string;
  year: string;
  doi: string;
  /** The stored file's name inside the source directory: `original.pdf`. */
  file: string;
  /** What the file was called when it was dropped, for the page and the export. */
  originalName: string;
  bytes: number;
  sha256: string;
  /** Pages of text, or 1 for a document with no page boundaries. */
  pages: number;
  /** Whether page numbers mean anything -- false for a Word or Markdown file. */
  paged: boolean;
  text: TextStatus;
  /** Why the text could not be read, in the extractor's words. */
  textError?: string;
  addedAt: string;
}

/** The files a source can be made from -- what the extractor can actually read. */
export const SOURCE_EXTENSIONS = ["pdf", "docx", "odt", "rtf", "md", "markdown", "txt", "tex"] as const;

export function sourceExtension(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return (SOURCE_EXTENSIONS as readonly string[]).includes(ext) ? ext : undefined;
}

function randomSalt(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 4);
}

/** The shape every other store's id takes: date, time, a slug, and a salt against same-minute collisions. */
export function sourceId(title: string, now = new Date(), salt = randomSalt()): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}` +
    `-${two(now.getHours())}${two(now.getMinutes())}`;
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .split("-")
    .filter(Boolean)
    .slice(0, 6)
    .join("-")
    .slice(0, 60);
  return `${stamp}-${slug || "paper"}${salt ? `-${salt}` : ""}`;
}

/**
 * A source id, refused if it is anything but one -- `assertRunId`'s rule, for
 * `assertRunId`'s reason: it comes back from the window and from a model's
 * tool call to be joined onto the sources root, read, and `rm -rf`'d.
 */
export function assertSourceId(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === ".." || id.length > 120) {
    throw new Error(`no paper named ${JSON.stringify(id)}`);
  }
  return id;
}

/** The ref the paper tools use for an uploaded paper, beside a bare Zotero key. */
export const SOURCE_REF = "source:";

/** A DOI as printed on a paper's first pages -- the first one, which is the paper's own on nearly all of them. */
export function doiFrom(pages: readonly string[]): string {
  const head = pages.slice(0, 2).join("\n");
  const match = head.match(/\b(10\.\d{4,9}\/[^\s"<>]+)/i);
  return match ? match[1]!.replace(/[.,;:)\]]+$/, "") : "";
}

/**
 * A title guessed from the first page: the first line that reads like one.
 *
 * Not the first line, which on most published PDFs is a running header, a
 * journal name or a licence notice. Wrong often enough that the page shows it
 * as editable and says it was guessed.
 */
export function titleGuess(pages: readonly string[], fallback: string): string {
  for (const raw of (pages[0] ?? "").split("\n").slice(0, 40)) {
    const line = raw.trim().replace(/\s+/g, " ");
    const words = line.split(" ").length;
    if (words < 3 || words > 30 || line.length > 250) continue;
    if (/https?:|www\.|doi|©|copyright|arxiv|journal|vol\.|volume|issn|received|accepted|licen[cs]e/i.test(line)) continue;
    if (/^\d|[.;]$/.test(line)) continue;
    return line;
  }
  return fallback.replace(/\.[^.]+$/, "").trim() || "Untitled paper";
}

/** A source read back off disk, rebuilt field by field -- a listing that throws on the fifth is worse than one that skips it. */
export function parseSource(raw: unknown, id: string): Source | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const str = (key: string): string => (typeof row[key] === "string" ? (row[key] as string) : "");
  const num = (key: string): number =>
    typeof row[key] === "number" && Number.isFinite(row[key]) ? Math.max(0, Math.round(row[key] as number)) : 0;
  const file = str("file");
  if (!file || /[\\/]/.test(file) || file.startsWith(".")) return undefined;
  const text = row["text"] === "ok" || row["text"] === "scanned" ? row["text"] : "failed";
  return {
    id,
    title: str("title") || "Untitled paper",
    authors: str("authors"),
    year: str("year"),
    doi: str("doi"),
    file,
    originalName: str("originalName") || file,
    bytes: num("bytes"),
    sha256: str("sha256"),
    pages: num("pages"),
    paged: row["paged"] !== false,
    text,
    ...(str("textError") ? { textError: str("textError") } : {}),
    addedAt: str("addedAt"),
  };
}

/** What a person may correct on the page. Everything else is a fact about the file. */
export interface SourceEdit {
  title?: string;
  authors?: string;
  year?: string;
  doi?: string;
}

export function editSource(source: Source, edit: SourceEdit): Source {
  const trim = (v: string | undefined, cap: number): string | undefined =>
    typeof v === "string" ? v.trim().slice(0, cap) : undefined;
  const title = trim(edit.title, 300);
  const authors = trim(edit.authors, 500);
  const year = trim(edit.year, 12);
  const doi = trim(edit.doi, 200);
  return {
    ...source,
    ...(title !== undefined ? { title: title || source.title } : {}),
    ...(authors !== undefined ? { authors } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(doi !== undefined ? { doi: doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "") } : {}),
  };
}

/** The link a citation marker resolves to, when there is one to resolve to. */
export function sourceLink(source: Pick<Source, "doi">): string | undefined {
  return source.doi ? `https://doi.org/${source.doi}` : undefined;
}
