/**
 * Driving LibreOffice and pdftotext from the agent.
 *
 * Deliberately boring: spawn, wait, check the file appeared. The interesting
 * decisions are in formats.ts; what is here is the operational care that a
 * headless office suite needs and that its exit code will not give you.
 */

import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { convertArgs, extensionOf, outputName, type Format } from "./formats.ts";

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

/**
 * Convert one file into `outDir`, returning the path it produced.
 *
 * The exit code is not trusted on its own. LibreOffice exits 0 having converted
 * nothing when it does not recognise a filter, so the check is that the output
 * file exists and is not empty.
 */
export async function convert(source: string, format: Format, outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const profile = await scratchDir("lo-");
  try {
    const result = await run(
      "libreoffice",
      convertArgs({ source, format, outDir, profileDir: profile }),
      CONVERT_TIMEOUT_MS,
    );
    const produced = join(outDir, outputName(source, format));
    try {
      const info = await stat(produced);
      if (info.size === 0) throw new Error("empty");
      return produced;
    } catch {
      throw new DocsError(
        `the conversion produced no ${format.ext} file` +
          `${result.stderr.trim() ? `: ${result.stderr.trim().slice(0, 300)}` : ""}`,
      );
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
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
    const md = await convert(abs, { ext: "md", convertTo: "md", label: "Markdown", readable: true }, out);
    return await readFile(md, "utf8");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}
