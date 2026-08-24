/**
 * Driving pandoc and pdftotext from the agent.
 *
 * Deliberately boring: spawn, wait, check the file appeared. The interesting
 * decisions are in formats.ts; what is here is the operational care that these
 * tools need and that their exit codes will not give you.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { FORMATS, extensionOf, outputName, pandocArgs, pandocReader, type Format } from "./formats.ts";

export class DocsError extends Error {
  override readonly name = "DocsError";
}

/** pandoc is fast, but a very long document on a slow disk is not instant. */
const CONVERT_TIMEOUT_MS = 120_000;

/**
 * Where the bundled binaries live, relative to the app.
 *
 * Overridable so a developer can point at a system install, and so the tests
 * can run against whatever the machine happens to have.
 */
export function vendorDir(): string {
  return process.env["KAREN_VENDOR_DIR"] ?? join(process.resourcesPath ?? ".", "vendor", platform());
}

/**
 * The pandoc to run: the bundled one if it is there, otherwise the PATH.
 *
 * Bundled wins deliberately. A user's own pandoc may be years old -- the docx
 * writer in particular has changed a lot -- and a document that comes out
 * subtly different depending on the machine is worse than one that comes out
 * the same everywhere.
 */
export function pandocPath(): string {
  const bundled = join(vendorDir(), platform() === "win32" ? "pandoc.exe" : "pandoc");
  return existsSync(bundled) ? bundled : "pandoc";
}

/** Where the agent may read and write. */
export function workspaceRoot(): string {
  return process.env["KAREN_WORKSPACE"] ?? join(homedir(), "Documents", "karen");
}

/**
 * Documents live in one place, so there is one folder to jail and one to open.
 *
 * A plain path, never a dot-directory. The reason predates pandoc and outlives
 * it: sandboxed packaging -- snap, flatpak, the Mac App Store -- routinely
 * refuses hidden directories under $HOME, and a folder the user cannot find in
 * their file manager is a folder they will assume is empty.
 */
export function documentsDir(): string {
  return join(workspaceRoot(), "documents");
}

/**
 * Scratch space for conversions, inside the workspace rather than in /tmp.
 *
 * This is not a preference, and it is the finding most likely to be undone by
 * someone tidying up. v1 ran LibreOffice as a snap, and **snaps get a private
 * /tmp**: a conversion given an output path under /tmp succeeded, reported
 * success, and wrote the file into a namespace this process could not see, so
 * the output appeared to have vanished. Found by doing exactly that.
 *
 * The engine changed; the hazard did not. Any sandboxed packaging can remap
 * /tmp the same way, so conversions stay inside the workspace where both sides
 * agree the path means one thing.
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

/** What is actually available. Probed once; binaries do not appear mid-run. */
let probed: Engines | undefined;

export interface Engines {
  /** pandoc is present, so anything but PDF can be produced. */
  pandoc: boolean;
  /** Where it was found, so the About pane can say whether it is the bundled one. */
  pandocPath?: string;
  pandocVersion?: string;
  /** poppler is present, so PDFs can be read. */
  pdftotext: boolean;
}

async function present(command: string): Promise<string | undefined> {
  try {
    const { code, stdout } = await run(command, ["--version"], 20_000);
    return code === 0 ? stdout.split("\n")[0]?.trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function engines(): Promise<Engines> {
  if (!probed) {
    const path = pandocPath();
    const version = await present(path);
    probed = {
      pandoc: version !== undefined,
      ...(version ? { pandocPath: path, pandocVersion: version } : {}),
      pdftotext: (await present("pdftotext")) !== undefined,
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

const HTML_FORMAT: Format = {
  ext: "html", pandocTo: "html", pandocFrom: "html", label: "HTML", readable: true,
};

/**
 * Convert one file into `outDir`, returning the path it produced.
 *
 * The exit code is not trusted on its own -- the check is always that the
 * output file exists and is not empty.
 */
export async function convert(source: string, format: Format, outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const produced = join(outDir, outputName(source, format));

  // PDF has no pandoc writer here, so it goes through HTML and the app's own
  // browser engine. Two steps, but no LaTeX toolchain to install.
  if (format.ext === "pdf") {
    if (!pdfRenderer) {
      throw new DocsError(
        "PDF output is unavailable: this build has no renderer attached. " +
          "Write the document as Markdown, Word or OpenDocument instead.",
      );
    }
    const html = await convert(source, HTML_FORMAT, outDir);
    try {
      await pdfRenderer(await readFile(html, "utf8"), produced);
    } finally {
      // The intermediate is not the user's document and must not be left in
      // their folder looking like one, even when the render failed.
      await rm(html, { force: true });
    }
    return await verify(produced, format, "");
  }

  const from = pandocReader(source);
  const to = format.pandocTo;
  if (!from) throw new DocsError(`${extensionOf(source) || "that file"} is not a format pandoc can read`);
  if (!to) throw new DocsError(`${format.label} is not a format pandoc can write`);

  const { pandoc } = await engines();
  if (!pandoc) {
    throw new DocsError(
      `Cannot convert to ${format.label}: pandoc was not found. ` +
        `Documents can still be written as Markdown.`,
    );
  }

  const result = await run(
    pandocPath(),
    pandocArgs({ source, from, to, output: produced }),
    CONVERT_TIMEOUT_MS,
  );
  return await verify(produced, format, result.stderr);
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
 * PDFs go through poppler's pdftotext rather than pandoc, because pandoc has no
 * PDF reader at all. poppler is also the right tool independently: it handles
 * the two-column layouts academic papers arrive in, and is an order of
 * magnitude faster than the JS libraries on a 40-page paper. `-layout` keeps
 * tables roughly readable.
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
    const md = await convert(abs, FORMATS["md"]!, out);
    return await readFile(md, "utf8");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}
