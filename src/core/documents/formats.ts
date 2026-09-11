/**
 * What MyRA can turn a document into, and how.
 *
 * **pandoc is the only engine.** For this audience that is not a compromise: an
 * academic writing tool needs CSL citation styles, bibliographies and journal
 * templates, which is pandoc's whole purpose. It is also a single static binary
 * that ships per platform, where LibreOffice was a gigabyte-scale prerequisite
 * the user had to install themselves.
 *
 * Two rules that must not be relaxed:
 *
 *  1. **The output path is always explicit.** Never let a converter choose
 *     where its output lands. v1 used LibreOffice, which writes beside the
 *     input under the same basename, so converting `report.docx` to Markdown
 *     silently destroyed a `report.md` sitting next to it. Observed, not
 *     theorised, and the reason `--output` is not optional here.
 *  2. **The argv is a fixed template.** No caller may add flags, and no value
 *     the model chose is ever spliced in. pandoc's `--lua-filter` and
 *     `--filter` execute arbitrary code by design, so a passthrough argument
 *     here would be a shell with extra steps -- and would hand back exactly the
 *     capability that removing pi took away.
 */

export interface Format {
  /** Extension, without the dot. */
  ext: string;
  /** pandoc's writer name, or undefined when pandoc cannot produce it directly. */
  pandocTo?: string;
  /** pandoc's reader name, or undefined when pandoc cannot read it. */
  pandocFrom?: string;
  label: string;
  /** True when this is something the model can read back as text. */
  readable: boolean;
}

export const FORMATS: Record<string, Format> = {
  md: { ext: "md", pandocTo: "markdown", pandocFrom: "markdown", label: "Markdown", readable: true },
  // `plain` rather than a markdown writer: asked for plain text, a reader wants
  // the asterisks and hashes gone, not turned into different ones.
  txt: { ext: "txt", pandocTo: "plain", pandocFrom: "markdown", label: "plain text", readable: true },
  html: { ext: "html", pandocTo: "html", pandocFrom: "html", label: "HTML", readable: true },
  docx: { ext: "docx", pandocTo: "docx", pandocFrom: "docx", label: "Word (.docx)", readable: true },
  odt: { ext: "odt", pandocTo: "odt", pandocFrom: "odt", label: "OpenDocument (.odt)", readable: true },
  rtf: { ext: "rtf", pandocTo: "rtf", pandocFrom: "rtf", label: "Rich Text", readable: true },
  // No pandocTo: pandoc's PDF writers need a LaTeX toolchain, far too heavy to
  // bundle beside a desktop app. PDF goes through HTML and the app's own
  // browser engine instead -- see main/pdf.ts.
  pdf: { ext: "pdf", label: "PDF", readable: false },
};

export const FORMAT_NAMES = Object.keys(FORMATS);

/** Extensions we can read text out of, whatever produced them. */
const READABLE = new Set([...Object.values(FORMATS).filter((f) => f.readable).map((f) => f.ext), "pdf", "text", "markdown"]);

export function isReadable(path: string): boolean {
  return READABLE.has(extensionOf(path));
}

export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function resolveFormat(name: string): Format | undefined {
  const key = name.trim().toLowerCase().replace(/^\./, "");
  if (key === "markdown") return FORMATS["md"];
  if (key === "word" || key === "doc") return FORMATS["docx"];
  if (key === "text") return FORMATS["txt"];
  return FORMATS[key];
}

/** The filename a conversion produces: same stem, new extension. */
export function outputName(source: string, format: Format): string {
  const base = source.slice(source.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return `${stem}.${format.ext}`;
}

/**
 * Turn a model-supplied name into a safe workspace-relative path.
 *
 * Returns undefined for anything that tries to leave the workspace. The agent
 * is inside a VM so this is not a security boundary, but a document written to
 * `/etc` is a document the user will never find, and `../../` in a filename is
 * far more often a confused model than an attack.
 */
export function safeRelativePath(name: string): string | undefined {
  const trimmed = name.trim().replace(/^\/+/, "");
  if (!trimmed) return undefined;
  if (trimmed.includes("\0")) return undefined;

  const parts: string[] = [];
  for (const segment of trimmed.split("/")) {
    if (segment === "" || segment === ".") continue;
    // No climbing, even if a later segment would come back inside: a path that
    // needs to leave and return is not a path anyone typed on purpose.
    if (segment === "..") return undefined;
    parts.push(segment);
  }
  if (parts.length === 0) return undefined;
  return parts.join("/");
}

/**
 * The name the model gave, ending in the extension the format needs.
 *
 * A name is supplied far more often than not, and it was used verbatim: asked
 * for "wm-transfer" as Markdown, MyRA wrote a file called `wm-transfer` with
 * no extension at all. It has the right bytes in it and it opens in nothing --
 * a double click gets a "choose an application" dialog, and the file manager
 * shows it as unknown. Observed, not hypothesised.
 *
 * Appended rather than replaced, so nothing in the name is destroyed. A name
 * that already ends in the right extension is left exactly as it is.
 */
export function withExtension(name: string, ext: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  return base.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? name : `${name}.${ext}`;
}

/** A filename for a draft, when the model did not give a usable one. */
export function slugName(title: string, ext: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return `${slug || "document"}.${ext}`;
}

/**
 * The argv for one pandoc conversion.
 *
 * Fixed shape, built here and nowhere else. Note what is absent and must stay
 * absent: `--lua-filter`, `--filter`, `--metadata-file`, `-V`, and any
 * caller-supplied flag list. Each of those executes or injects something the
 * model could choose, and this file is the only place that decides.
 *
 * `--sandbox` restricts the reader's filesystem access to the files named on
 * the command line, which matters because the input can be a document that
 * came off the open web.
 *
 * `--standalone` is required for the container formats: without it pandoc emits
 * an HTML fragment with no <head>, and a .docx with no document skeleton.
 */
export function pandocArgs(opts: {
  source: string;
  from: string;
  to: string;
  output: string;
}): string[] {
  return [
    "--sandbox",
    "--standalone",
    "--from",
    opts.from,
    "--to",
    opts.to,
    "--output",
    opts.output,
    opts.source,
  ];
}

/** The reader pandoc should use for a file, by extension. */
export function pandocReader(path: string): string | undefined {
  const ext = extensionOf(path);
  if (ext === "md" || ext === "markdown" || ext === "txt" || ext === "text") return "markdown";
  return FORMATS[ext]?.pandocFrom;
}
