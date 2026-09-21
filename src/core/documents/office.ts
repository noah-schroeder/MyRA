/**
 * Driving pandoc and pdftotext from the agent.
 *
 * Deliberately boring: spawn, wait, check the file appeared. The interesting
 * decisions are in formats.ts; what is here is the operational care that these
 * tools need and that their exit codes will not give you.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { makePrivateDir, OWNER_ONLY_FILE, toolsDir } from "../paths.ts";
import { FORMATS, extensionOf, outputName, pandocArgs, pandocReader, type Format } from "./formats.ts";
import { scrubbedEnv } from "../childEnv.ts";

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
  return process.env["MYRA_VENDOR_DIR"] ?? join(process.resourcesPath ?? ".", "vendor", platform());
}

/**
 * The pandoc to run: the bundled one if it is there, otherwise the PATH.
 *
 * Bundled wins deliberately. A user's own pandoc may be years old -- the docx
 * writer in particular has changed a lot -- and a document that comes out
 * subtly different depending on the machine is worse than one that comes out
 * the same everywhere.
 */
export function pandocBinaryName(): string {
  return platform() === "win32" ? "pandoc.exe" : "pandoc";
}

/** Where a pandoc fetched on first run is kept. */
export function installedPandocPath(): string {
  return join(toolsDir(), pandocBinaryName());
}

export function pandocPath(): string {
  const name = pandocBinaryName();
  // Bundled first, then the copy fetched on first run, then whatever the user
  // has. Each step is a weaker guarantee about which version answers.
  for (const candidate of [join(vendorDir(), name), installedPandocPath()]) {
    if (existsSync(candidate)) return candidate;
  }
  return "pandoc";
}

/**
 * The folder the user named in Settings, if they named one.
 *
 * Held here rather than read from the config store, for the reason
 * zoteroSqlite.ts holds its own: this module is on the path of every document
 * tool and must not acquire a dependency on settings having loaded first. The
 * main process sets it at startup and on every change, which is the same
 * lifetime the setting has.
 */
let chosenRoot = "";

export function setWorkspaceRoot(dir: string | undefined): void {
  chosenRoot = (dir ?? "").trim();
}

/**
 * Where the agent may read and write.
 *
 * The setting was written, shown in Settings as "Documents", and then not read
 * by anything on this path: the jail was whatever `MYRA_WORKSPACE` said or the
 * hardcoded default, so pointing Documents somewhere else moved the project
 * export and left the agent writing to the old folder. The env var still wins,
 * because it is how the tests and a developer's launcher say where to work, and
 * a stored setting must not silently override the thing that started the app.
 */
export function workspaceRoot(): string {
  return process.env["MYRA_WORKSPACE"] ?? (chosenRoot || join(homedir(), "Documents", "myra"));
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
  await makePrivateDir(scratchRoot());
  return await mkdtemp(join(scratchRoot(), prefix));
}


async function run(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      /* pandoc and pdftotext need to be found, to run in a locale and
         to write a temporary file. Nothing else here is theirs. */
      env: scrubbedEnv(process.env),
    });
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;

    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (stderr = (stderr + c.toString("utf8")).slice(-4000)));
    child.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      fail(
        err.code === "ENOENT"
          ? new DocsError(
              command.endsWith("pandoc") || command.endsWith("pandoc.exe")
                ? "pandoc is not installed, so this format cannot be written. " +
                  "Install it from Settings → Document tools."
                : `${command} is not installed on this machine`,
            )
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

/*
 * Ask a binary its version, in the dialect that binary speaks.
 *
 * `--version` is not universal. poppler's pdftotext has no such flag and reads
 * it as a filename, so it answered "Couldn't open file '--version'" and exited
 * 1 -- which this read as absent. MyRA then reported pdftotext missing on
 * every machine that had it, poppler's own convention being `-v`, and printed
 * it to stderr at that.
 */
async function present(command: string, flag = "--version"): Promise<string | undefined> {
  try {
    const { code, stdout, stderr } = await run(command, [flag], 20_000);
    if (code !== 0) return undefined;
    const line = (stdout.trim() || stderr.trim()).split("\n")[0]?.trim();
    return line || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Forget what was probed.
 *
 * The cache above is right for a normal run -- binaries do not appear
 * mid-session -- and wrong for exactly one moment: the first run, where the app
 * installs pandoc itself and would otherwise go on reporting the absence it
 * measured at startup until restarted.
 */
export function forgetEngines(): void {
  probed = undefined;
}

export async function engines(): Promise<Engines> {
  if (!probed) {
    const path = pandocPath();
    const version = await present(path);
    probed = {
      pandoc: version !== undefined,
      ...(version ? { pandocPath: path, pandocVersion: version } : {}),
      pdftotext: (await present("pdftotext", "-v")) !== undefined,
    };
  }
  return probed;
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
  await makePrivateDir(outDir);
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

/**
 * Write text to a file, creating the directory it lives in.
 *
 * Written under an unguessable name and renamed into place, which is the rule
 * this codebase already states twice -- images write a sidecar last and a
 * research stage writes `<name>.partial` and finalises it -- and which this,
 * the one write reached by a model-supplied name, skipped.
 *
 * Here the reason is the gap between resolving a path and using it.
 * `resolveInJail` returns a STRING, and for a document that does not exist yet
 * -- the ordinary write_document case -- the final component was checked
 * against a filesystem that did not contain it. Anything able to plant a
 * symlink at that path in the meantime had the write follow it out of the
 * jail. Two properties close it, and neither needs a platform-specific flag:
 *
 *   - `"wx"` is O_CREAT|O_EXCL, which refuses to follow a symlink at the final
 *     component on every POSIX platform -- it fails EEXIST even for a dangling
 *     one -- and is CREATE_NEW on Windows. A random suffix means the name
 *     cannot have been created in advance, the same argument `mkdtemp` already
 *     carries in capture.ts and tools/pandoc.ts.
 *   - `rename` REPLACES a symlink standing at the destination rather than
 *     writing through it. So the dangerous operation is removed rather than
 *     guarded.
 *
 * What remains, stated rather than waved at: `rename` resolves the PARENT
 * directory fresh, so swapping an intermediate directory for a symlink inside
 * the same window still lands the file elsewhere -- as does `makePrivateDir`
 * below, which is `mkdir -p` and will happily create real directories through
 * one. Closing that needs openat/O_DIRECTORY walking, which Node does not
 * expose and which is not worth a native dependency. The precondition for
 * either is write access inside a directory created 0700, which means a
 * process already running as this user, or a workspace the user deliberately
 * pointed at a shared or synced folder. See docs/threat-model.md.
 */
export async function writeText(abs: string, content: string): Promise<number> {
  await makePrivateDir(dirname(abs));
  const temporary = `${abs}.${randomUUID().slice(0, 8)}.part`;
  try {
    const handle = await open(temporary, "wx", OWNER_ONLY_FILE);
    try {
      await handle.writeFile(content, { encoding: "utf8" });
    } finally {
      await handle.close();
    }
    await rename(temporary, abs);
  } catch (err) {
    // Never leave a half-written .part behind for a listing to show.
    await rm(temporary, { force: true }).catch(() => undefined);
    throw err;
  }
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
