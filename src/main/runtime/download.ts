/**
 * Fetching large files without lying to the user about it.
 *
 * Three things this has to get right, all of which are about a download that
 * takes twenty minutes rather than one that takes two seconds:
 *
 *   - **Resume.** A 30 GB model will be interrupted. Restarting from zero
 *     because a laptop lid closed is not acceptable, so an interrupted file is
 *     continued with a Range request.
 *   - **Verify.** GitHub gives a sha256 per release asset and HuggingFace gives
 *     one per file, in both cases from a different host than the bytes. Checking
 *     costs one pass over data we already have in hand.
 *   - **Leave nothing behind.** A cancelled or failed download deletes its
 *     partial file rather than leaving something that looks installed.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";

export class DownloadError extends Error {
  override readonly name = "DownloadError";
}

export interface Progress {
  receivedBytes: number;
  totalBytes?: number;
  /** Bytes per second over the last sample, for an honest time estimate. */
  bytesPerSecond: number;
}

export interface DownloadOptions {
  sha256?: string;
  headers?: Record<string, string>;
  onProgress?: (p: Progress) => void;
  signal?: AbortSignal;
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * Download to `dest`, resuming if a partial file is already there.
 *
 * The partial lives at `dest + ".part"` so that the presence of `dest` always
 * means a complete, verified file -- there is no state in which a half-written
 * model looks ready to load.
 */
export async function downloadFile(url: string, dest: string, opts: DownloadOptions = {}): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let have = await sizeOf(part);

  const headers: Record<string, string> = { ...opts.headers };
  if (have > 0) headers["range"] = `bytes=${have}-`;

  const res = await fetch(url, {
    headers,
    ...(opts.signal ? { signal: opts.signal } : {}),
    redirect: "follow",
  });

  // A server that ignores Range answers 200 with the whole file; continuing to
  // append would corrupt it, so start over instead.
  if (have > 0 && res.status === 200) {
    await rm(part, { force: true });
    have = 0;
  }
  if (!res.ok && res.status !== 206) {
    throw new DownloadError(`${res.status} ${res.statusText} from ${new URL(url).host}`);
  }
  if (!res.body) throw new DownloadError("the server sent no body");

  const declared = Number(res.headers.get("content-length") ?? "0");
  const totalBytes = declared > 0 ? declared + have : undefined;

  let received = have;
  let lastAt = Date.now();
  let lastBytes = received;

  const stream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  stream.on("data", (chunk: Buffer) => {
    received += chunk.length;
    const now = Date.now();
    if (now - lastAt >= 250) {
      opts.onProgress?.({
        receivedBytes: received,
        ...(totalBytes ? { totalBytes } : {}),
        bytesPerSecond: ((received - lastBytes) * 1000) / (now - lastAt),
      });
      lastAt = now;
      lastBytes = received;
    }
  });

  try {
    await pipeline(stream, createWriteStream(part, { flags: have > 0 ? "a" : "w" }));
  } catch (err) {
    // An aborted download keeps its partial file: that is what makes the next
    // attempt a resume rather than a restart.
    if ((err as Error).name === "AbortError") throw err;
    throw new DownloadError(`${(err as Error).message} while downloading from ${new URL(url).host}`);
  }

  if (opts.sha256) {
    const actual = await hashFile(part);
    if (actual !== opts.sha256.toLowerCase()) {
      await rm(part, { force: true });
      throw new DownloadError(
        `the downloaded file does not match its published checksum — expected ${opts.sha256.slice(0, 12)}…, ` +
          `got ${actual.slice(0, 12)}…. The file was discarded.`,
      );
    }
  }

  await rename(part, dest);
  opts.onProgress?.({ receivedBytes: received, ...(totalBytes ? { totalBytes } : {}), bytesPerSecond: 0 });
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/**
 * Unpack a `.tar.gz` or `.zip`.
 *
 * `tar` is used for both, and is present everywhere we ship: GNU tar on Linux,
 * bsdtar on macOS, and bsdtar in Windows 10 1803 and later -- which also reads
 * zip archives, so one code path covers every platform.
 *
 * The archive's checksum is verified before this is called, which is the real
 * protection: an attacker who could rewrite the bytes could otherwise plant a
 * path-traversal entry, and no extractor flag would save us.
 */
export async function extractArchive(archive: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xf", archive, "-C", destDir], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()));
    child.on("error", (err) => reject(new DownloadError(`could not run tar: ${err.message}`)));
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new DownloadError(`tar failed (${code}): ${stderr.trim().slice(0, 400)}`)),
    );
  });
}

/** Find a named executable anywhere under a directory. Archives vary in layout. */
export async function findExecutable(dir: string, name: string): Promise<string | undefined> {
  const { readdir } = await import("node:fs/promises");
  const wanted = process.platform === "win32" ? `${name}.exe` : name;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name === wanted) return path;
    }
  }
  return undefined;
}
