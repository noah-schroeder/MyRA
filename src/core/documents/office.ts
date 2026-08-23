/**
 * Driving pandoc, LibreOffice and pdftotext from the agent.
 *
 * Deliberately boring: spawn, wait, check the file appeared. The interesting
 * decisions are in formats.ts; what is here is the operational care that these
 * tools need and that their exit codes will not give you.
 */

import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  convertArgs, extensionOf, outputName, pandocArgs, pandocReader, type Format,
} from "./formats.ts";

export class DocsError extends Error {
  override readonly name = "DocsError";
}

/**
 * A cold snap start is genuinely slow -- the first conversion after boot can
 * take the better part of a minute before it has even loaded the filter.
 */
const CONVERT_TIMEOUT_MS = 180_000;

/** Where the agent may read and write. */
export function workspaceRoot(): string {
  return process.env["KAREN_WORKSPACE"] ?? join(homedir(), "Documents", "karen");
}

/**
 * Documents live in one place so the host's "Save to host…" knows where to look.
 *
 * A plain path, not a dot-directory: LibreOffice here is a snap, and snap
 * confinement refuses hidden directories in $HOME.
 */
export function documentsDir(): string {
  return join(workspaceRoot(), "documents");
}

/**
 * Scratch space for conversions, inside the workspace rather than in /tmp.
 *
 * This is not a preference. LibreOffice here is a snap, and **snaps get a
 * private /tmp**: a conversion given `--outdir /tmp/...` succeeds, reports
 * success, and writes the file into a namespace this process cannot see. The
 * output then appears to have vanished. Found by doing exactly that.
 *
 * A plain directory name, too -- snap confinement also refuses hidden
 * directories under $HOME, so no dot-names here.
 */
export function scratchRoot(): string {
  return join(workspaceRoot(), "scratch");
}

async function scratchDir(prefix: string): Promise<string> {
  await mkdir(scratchRoot(), { recursive: true });
  return await mkdtemp(join(scratchRoot(), prefix));
}

/** Absolute path for a workspace-relative one, refusing anything outside. */
export function inWorkspace(rel: string): string {
  const root = resolve(documentsDir());
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + "/")) {
    throw new DocsError(`${rel} is outside the documents folder`);
  }
  return abs;
}

async function run(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;

    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (stderr = (stderr + c.toString("utf8")).slice(-4000)));
    child.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      fail(
        err.code === "ENOENT"
          ? new DocsError(`${command} is not installed in the VM`)
          : new DocsError(err.message),
      );
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });

    timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new DocsError(`${command} did not finish within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });
}

/** Which binaries are actually present. Probed once; they do not appear mid-run. */
let probed: { pandoc: boolean; libreoffice: boolean } | undefined;

async function present(command: string): Promise<boolean> {
  try {
    const { code } = await run(command, ["--version"], 20_000);
    return code === 0;
  } catch {
    return false;
  }
}

export async function engines(): Promise<{ pandoc: boolean; libreoffice: boolean }> {
  if (!probed) {
    probed = {
      pandoc: await present("pandoc"),
      libreoffice: await present("libreoffice"),
    };
  }
  return probed;
}

/** Clears the probe. Tests only. */
export function resetEngines(): void {
  probed = undefined;
}

/**
 * Rendering HTML to PDF.
 *
 * pandoc's PDF writers want a LaTeX toolchain, which is far too heavy to bundle
 * beside a desktop app. The app already ships a browser engine, so the renderer
 * installs a function here that prints HTML to PDF. Core cannot call Electron
 * itself, hence the seam; left uninstalled, PDF output is refused with a
 * message rather than silently skipped.
 */
let pdfRenderer: ((html: string, outPath: string) => Promise<void>) | undefined;

export function setPdfRenderer(fn: (html: string, outPath: string) => Promise<void>): void {
  pdfRenderer = fn;
}

export function canRenderPdf(): boolean {
  return pdfRenderer !== undefined;
}

/**
 * Convert one file into `outDir`, returning the path it produced.
 *
 * The exit code is not trusted on its own. LibreOffice exits 0 having converted
 * nothing when it does not recognise a filter, so the check is always that the
 * output file exists and is not empty.
 */
export async function convert(source: string, format: Format, outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const produced = join(outDir, outputName(source, format));
  const available = await engines();

  if (format.ext === "pdf") {
    if (pdfRenderer) {
      const html = await convert(source, FORMATS_HTML, outDir);
      await pdfRenderer(await readFile(html, "utf8"), produced);
      await rm(html, { force: true });
      return await verify(produced, format, "");
    }
    if (!available.libreoffice) {
      throw new DocsError(
        "PDF output is unavailable: no renderer is installed and LibreOffice was not found.",
      );
    }
    return await viaLibreOffice(source, format, outDir, produced);
  }

  if (available.pandoc) {
    const from = pandocReader(source);
    const to = format.pandocTo;
    if (from && to) {
      const result = await run(
        "pandoc",
        pandocArgs({ source, from, to, output: produced }),
        CONVERT_TIMEOUT_MS,
      );
      return await verify(produced, format, result.stderr);
    }
  }

  if (!available.libreoffice) {
    throw new DocsError(
      `Cannot convert to ${format.label}: neither pandoc nor LibreOffice is available.`,
    );
  }
  return await viaLibreOffice(source, format, outDir, produced);
}

const FORMATS_HTML: Format = {
  ext: "html", convertTo: "html", pandocTo: "html", pandocFrom: "html",
  label: "HTML", readable: true,
};

async function viaLibreOffice(
  source: string,
  format: Format,
  outDir: string,
  produced: string,
): Promise<string> {
  const profile = await scratchDir("lo-");
  try {
    const result = await run(
      "libreoffice",
      convertArgs({ source, format, outDir, profileDir: profile }),
      CONVERT_TIMEOUT_MS,
    );
    return await verify(produced, format, result.stderr);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

async function verify(produced: string, format: Format, stderr: string): Promise<string> {
  try {
    const info = await stat(produced);
    if (info.size === 0) throw new Error("empty");
    return produced;
  } catch {
    throw new DocsError(
      `the conversion produced no ${format.ext} file` +
        `${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ""}`,
    );
  }
}

/** Write text to a file, creating the directory it lives in. */
export async function writeText(abs: string, content: string): Promise<number> {
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
  return Buffer.byteLength(content, "utf8");
}

export async function exists(abs: string): Promise<boolean> {
  try {
    await access(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a document back as text.
 *
 * PDFs go through pdftotext rather than LibreOffice: LibreOffice opens a PDF in
 * Draw, where every line becomes its own text frame, and the "text" that comes
 * back out is shredded. `-layout` keeps tables roughly readable.
 */
export async function readAsText(abs: string): Promise<string> {
  const ext = extensionOf(abs);

  if (ext === "pdf") {
    const out = await scratchDir("pdf-");
    try {
      const target = join(out, "text.txt");
      await run("pdftotext", ["-layout", abs, target], 60_000);
      return await readFile(target, "utf8");
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }

  if (ext === "md" || ext === "txt" || ext === "text" || ext === "markdown") {
    return await readFile(abs, "utf8");
  }

  // Everything else round-trips through Markdown, which keeps headings, lists
  // and emphasis the model can act on rather than flattening to a wall of text.
  const out = await scratchDir("doc-");
  try {
    const md = await convert(
      abs,
      { ext: "md", convertTo: "md", pandocTo: "markdown", pandocFrom: "markdown", label: "Markdown", readable: true },
      out,
    );
    return await readFile(md, "utf8");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}
