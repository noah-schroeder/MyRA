/**
 * What Karen can turn a document into, and how.
 *
 * All of this runs inside the VM. The host has no document verb at all — the
 * agent drafts here, and the user pulls the finished file across with a native
 * file dialog. That asymmetry is deliberate and is why there is no `save to
 * ~/anywhere` tool in this file.
 *
 * Two findings from testing against the LibreOffice that is actually installed
 * (26.2.5.2, as a snap), both of which shape the code:
 *
 *  1. **Markdown is a first-class import filter now.** The original plan called
 *     for pandoc to get Markdown into ODT/DOCX. It is not needed: LibreOffice
 *     parses Markdown itself — headings become headings and `**bold**` becomes a
 *     real bold run. pandoc is still used when present, but nothing requires it.
 *  2. **Conversion overwrites by default, and that loses work.** LibreOffice
 *     writes its output beside the input under the same basename, so converting
 *     `report.docx` to Markdown silently destroys a `report.md` sitting next to
 *     it. Observed, not theorised. Every conversion here passes `--outdir`.
 */

export interface Format {
  /** Extension, without the dot. */
  ext: string;
  /** What `--convert-to` is given. Some formats need an explicit filter. */
  convertTo: string;
  label: string;
  /** True when this is something the model can read back as text. */
  readable: boolean;
}

export const FORMATS: Record<string, Format> = {
  md: { ext: "md", convertTo: "md", label: "Markdown", readable: true },
  txt: { ext: "txt", convertTo: "txt:Text", label: "plain text", readable: true },
  html: { ext: "html", convertTo: "html", label: "HTML", readable: true },
  // The explicit filter matters: without it LibreOffice picks the Word 97
  // binary writer for .doc-adjacent requests, and the result is a .docx that
  // some tools refuse to open.
  docx: { ext: "docx", convertTo: "docx:MS Word 2007 XML", label: "Word (.docx)", readable: true },
  odt: { ext: "odt", convertTo: "odt", label: "OpenDocument (.odt)", readable: true },
  rtf: { ext: "rtf", convertTo: "rtf", label: "Rich Text", readable: true },
  pdf: { ext: "pdf", convertTo: "pdf", label: "PDF", readable: false },
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
 * The argv for one conversion.
 *
 * `--outdir` is not optional -- see the overwrite finding above. The private
 * user profile is likewise load-bearing: LibreOffice takes a lock on its
 * profile, so a headless conversion started while the user has LibreOffice open
 * would otherwise fail outright with a message about another instance.
 */
export function convertArgs(opts: {
  source: string;
  format: Format;
  outDir: string;
  profileDir: string;
}): string[] {
  return [
    `-env:UserInstallation=file://${opts.profileDir}`,
    "--headless",
    "--norestore",
    "--convert-to",
    opts.format.convertTo,
    "--outdir",
    opts.outDir,
    opts.source,
  ];
}
