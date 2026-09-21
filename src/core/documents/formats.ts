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

/**
 * The last component of a path the OS produced.
 *
 * Splits on both separators, which is the exact opposite of what
 * safeRelativePath does with a backslash -- and the asymmetry is the point.
 * This reads a path that already exists, where `\` is a separator on Windows
 * and cannot be anything else; that one validates a name a model chose, where
 * reinterpreting `\` as a separator is how a jail gets walked out of.
 */
export function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(cut + 1);
}

export function extensionOf(path: string): string {
  const base = baseName(path);
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
  const base = baseName(source);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return `${stem}.${format.ext}`;
}

/**
 * Names Windows resolves to a device rather than a file.
 *
 * `write_document{name:"NUL"}` reports success and writes nothing -- the bytes
 * go to the null device. Not an escape; a silent data-loss report, which is
 * worse than an error the model can read and act on. The extension does not
 * save it: `NUL.txt` is the same device.
 */
const RESERVED_WIN32 = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * Whether a name is absolute in any of the three spellings MyRA ships to.
 *
 * One function because two tools jail the same folder -- the document tools and
 * the draft outline -- and they must not disagree about what an absolute path
 * is. They each carried their own copy of this test, and each copy knew only
 * about `/`.
 */
export function looksAbsolute(name: string): boolean {
  const t = name.trim();
  return (
    t.startsWith("/") ||        // POSIX, and a UNC path's first character
    t.startsWith("\\") ||       // `\dir`, `\\server\share`, `\\?\C:\...`
    /^[A-Za-z]:/.test(t)        // a drive, with or without a following separator
  );
}

/**
 * Whether a name is trying to leave, as opposed to merely being awkward.
 *
 * `safeRelativePath` refuses both, and for a tool call that is right: the
 * model named a file and should be told the name was no good. The draft flow
 * needs the distinction, because it has a title to fall back on and a run
 * worth minutes to lose -- a colon in a heading should become a slug, and
 * `../../etc` should still be an error rather than a silent relocation.
 */
export function looksLikeEscape(name: string): boolean {
  if (looksAbsolute(name)) return true;
  return name.split(/[\\/]/).some((segment) => segment.trim() === "..");
}

/**
 * Turn a model-supplied name into a safe workspace-relative path.
 *
 * The textual half of the jail. The other half is the realpath comparison in
 * agent/tools/documents.ts, and neither is sufficient alone: text cannot see a
 * symlink, and realpath cannot see that `../../etc/passwd` was never a name
 * anybody meant.
 *
 * Every rule here is a pure string rule against the UNION of what is unsafe on
 * Linux, macOS and Windows -- never against the host platform. Two reasons.
 * The workspace is a folder people sync, so a name legal here may land on a
 * filesystem where it is not. And validating against the host means the jail is
 * only ever tested on the platform CI happens to run, which is how it came to
 * have a hole: this function split on "/" alone, so on Windows
 * `..\..\outside\x` was a single segment containing no `..`, passed every
 * check, and `path.win32.resolve` then honoured the backslashes.
 *
 * Keeping it import-free is what lets the renderer and outline.ts share it, and
 * what makes the answer byte-identical on all three platforms -- so one test
 * run covers all of them.
 */
export function safeRelativePath(name: string): string | undefined {
  const trimmed = name.trim().replace(/^\/+/, "");
  if (!trimmed) return undefined;
  if (trimmed.includes("\0")) return undefined;

  /* Refused, not split on. A backslash is a legal filename character on POSIX,
     so treating it as a separator would silently turn `a\b.md` into a file in a
     subdirectory -- the same silent relocation this boundary already refuses
     for a leading slash. Refusing also keeps the workspace portable, since a
     name containing one cannot be created on Windows or over SMB at all. */
  if (trimmed.includes("\\")) return undefined;

  const parts: string[] = [];
  for (const segment of trimmed.split("/")) {
    if (segment === "" || segment === ".") continue;
    // No climbing, even if a later segment would come back inside: a path that
    // needs to leave and return is not a path anyone typed on purpose.
    if (segment === "..") return undefined;

    /* A drive letter, and NTFS alternate data streams. `C:/Windows/x` keeps
       `C:` as an ordinary-looking segment, and win32.resolve then reads the
       result as an absolute path outside the jail; `notes.md:payload` writes a
       stream nothing lists. */
    if (segment.includes(":")) return undefined;

    /* Win32 strips trailing dots and spaces when it OPENS the file, after
       path.resolve has already accepted them. So `".. "` is not `..` to any
       check here, resolves to `<jail>\.. `, and CreateFile then opens
       `<jail>\..`. This is the one that survives every climb test. */
    if (/[. ]$/.test(segment)) return undefined;

    if (RESERVED_WIN32.has(segment.split(".")[0]!.toLowerCase())) return undefined;

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
  const base = baseName(name);
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
