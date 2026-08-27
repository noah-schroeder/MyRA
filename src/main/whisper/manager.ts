/**
 * Transcription, running on this machine.
 *
 * A second runtime beside llama.cpp, and it earns its own because llama.cpp
 * cannot do this job -- see `core/runtime/whisperAssets.ts` for what its binary
 * says about that. whisper-server is small (9 MB on Linux, 8 MB on Windows),
 * takes `--inference-path` so it can sit at the OpenAI path the app already
 * posts to, and returns the segment timestamps a two-track meeting is
 * assembled from.
 *
 * Deliberately smaller than the llama.cpp manager. There is no build list, no
 * rollback and no per-model tuning: one binary, one model, started when a
 * transcription is asked for and stopped when the app closes. Whisper models
 * are hundreds of megabytes rather than tens of gigabytes, and loading takes a
 * second rather than a minute, so none of that machinery buys anything.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_DIR, makeOwnDir, makePrivateDir, OWNER_ONLY_FILE } from "../../core/paths.ts";
import { downloadUrl, parseTree, treeUrl } from "../../core/runtime/hf.ts";
import {
  WHISPER_MODELS, WHISPER_REPO, newestWhisperRelease, whisperAsset, whisperUnavailable,
  type WhisperModel,
} from "../../core/runtime/whisperAssets.ts";
import type { Release } from "../../core/runtime/assets.ts";
import { sha256Of } from "../../core/runtime/assets.ts";
import {
  DownloadError, downloadFile, extractArchive, findExecutable, type Progress,
} from "../runtime/download.ts";

const RELEASES = "https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=20";
const CONFIG_PATH = join(CONFIG_DIR, "whisper.json");
const LOG_LINES = 60;
const READY_TIMEOUT_MS = 120_000;

/* Optionals written `?: T | undefined`: under exactOptionalPropertyTypes,
   clearing a field by assigning undefined -- which is what "that model is gone"
   means here -- is otherwise a type error. */
export interface WhisperConfig {
  /** The whisper-server binary, once a build is installed. */
  binary?: string | undefined;
  /** Release tag it came from, so the UI can name what is installed. */
  tag?: string | undefined;
  /** The ggml model file in use. */
  modelPath?: string | undefined;
  modelFile?: string | undefined;
  /** Use this local server rather than the endpoint in Settings. */
  useForTranscription: boolean;
}

const DEFAULTS: WhisperConfig = { useForTranscription: true };

export type WhisperState = "stopped" | "starting" | "ready" | "failed";

export interface WhisperStatus {
  state: WhisperState;
  baseUrl?: string | undefined;
  error?: string | undefined;
  log: string[];
  pid?: number | undefined;
}

export interface WhisperSnapshot {
  config: WhisperConfig;
  server: WhisperStatus;
  /** Models on disk, by filename. */
  installed: string[];
  /** Why nothing can be installed here, on a platform with no build. */
  unavailable?: string;
  catalogue: readonly WhisperModel[];
}

function buildsDir(): string {
  return join(CONFIG_DIR, "runtimes", "whisper.cpp");
}
function modelsDir(): string {
  return join(CONFIG_DIR, "whisper-models");
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/**
 * A model file name, refused if it is anything else.
 *
 * `useModel` and `removeModel` take this from the renderer and join it onto the
 * models directory, and `removeModel` ends in `rm`. A name is all that is ever
 * meant -- `ggml-base.en-q5_1.bin` -- so anything carrying a separator or a
 * `..` is not a mistyped model, it is a path, and the honest answer is no.
 *
 * The same rule `sessions.pathFor` applies to session ids, for the same reason:
 * the value lands in a path, so it is checked rather than trusted.
 */
export function modelFileName(file: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(file) || file === "." || file === "..") {
    throw new Error(`${JSON.stringify(file)} is not a model file name.`);
  }
  return file;
}

export class WhisperManager {
  #config: WhisperConfig = { ...DEFAULTS };
  #status: WhisperStatus = { state: "stopped", log: [] };
  #child: ChildProcess | undefined;
  #stopping = false;
  #installed: string[] = [];
  #listeners = new Set<(s: WhisperSnapshot) => void>();
  /** One start at a time: two transcriptions must not race two servers. */
  #starting: Promise<WhisperStatus> | undefined;

  get config(): WhisperConfig {
    return this.#config;
  }

  snapshot(): WhisperSnapshot {
    const why = whisperUnavailable(process.platform, process.arch);
    return {
      config: this.#config,
      server: this.#status,
      installed: this.#installed,
      ...(why ? { unavailable: why } : {}),
      catalogue: WHISPER_MODELS,
    };
  }

  onChange(fn: (s: WhisperSnapshot) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit(): void {
    const snap = this.snapshot();
    for (const fn of this.#listeners) fn(snap);
  }

  #set(patch: Partial<WhisperStatus>): void {
    this.#status = { ...this.#status, ...patch };
    this.#emit();
  }

  #log(line: string): void {
    this.#status = { ...this.#status, log: [...this.#status.log, line].slice(-LOG_LINES) };
    this.#emit();
  }

  async load(): Promise<WhisperConfig> {
    try {
      const parsed = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Partial<WhisperConfig>;
      this.#config = {
        ...DEFAULTS,
        ...parsed,
        useForTranscription: parsed.useForTranscription !== false,
      };
    } catch {
      this.#config = { ...DEFAULTS };
    }
    // A binary or model recorded in the file may have been deleted since. Drop
    // the reference rather than failing later with a confusing ENOENT.
    if (this.#config.binary && !existsSync(this.#config.binary)) delete this.#config.binary;
    if (this.#config.modelPath && !existsSync(this.#config.modelPath)) delete this.#config.modelPath;
    await this.rescanModels();
    return this.#config;
  }

  async update(patch: Partial<WhisperConfig>): Promise<WhisperConfig> {
    this.#config = { ...this.#config, ...patch };
    await makeOwnDir(CONFIG_DIR);
    await writeFile(CONFIG_PATH, JSON.stringify(this.#config, null, 2) + "\n", { mode: OWNER_ONLY_FILE });
    this.#emit();
    return this.#config;
  }

  async rescanModels(): Promise<string[]> {
    try {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(modelsDir(), { withFileTypes: true });
      this.#installed = entries.filter((e) => e.isFile() && e.name.endsWith(".bin")).map((e) => e.name);
    } catch {
      this.#installed = [];
    }
    this.#emit();
    return this.#installed;
  }

  /* ------------------------------------------------------------ install --- */

  async installBuild(
    signal?: AbortSignal,
    onProgress?: (p: Progress & { what: string }) => void,
  ): Promise<{ tag: string; binary: string }> {
    const why = whisperUnavailable(process.platform, process.arch);
    if (why) throw new DownloadError(why);

    const res = await fetch(RELEASES, {
      headers: { accept: "application/vnd.github+json", "user-agent": "Karen" },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new DownloadError(`could not reach GitHub to find whisper.cpp (${res.status})`);

    const target = { platform: process.platform, arch: process.arch };
    const release = newestWhisperRelease((await res.json()) as Release[], target);
    if (!release) throw new DownloadError("no whisper.cpp release carries a build for this machine.");
    const asset = whisperAsset(release.assets, target)!;

    const dir = join(buildsDir(), release.tag_name);
    const staging = join(CONFIG_DIR, "staging", `whisper-${release.tag_name}`);
    await rm(staging, { recursive: true, force: true });
    await makePrivateDir(staging);
    try {
      const archive = join(staging, asset.name);
      const digest = sha256Of(asset);
      await downloadFile(asset.browser_download_url, archive, {
        ...(digest ? { sha256: digest } : {}),
        ...(signal ? { signal } : {}),
        ...(onProgress
          ? { onProgress: (p: Progress) => onProgress({ ...p, what: `whisper.cpp ${release.tag_name}` }) }
          : {}),
      });
      await extractArchive(archive, staging);

      const found = await findExecutable(staging, "whisper-server");
      if (!found) throw new DownloadError("the whisper.cpp archive contained no whisper-server binary");

      /*
       * The whole directory moves, not just the binary.
       *
       * whisper-server loads `libggml-cpu-<arch>.so` from beside itself at
       * startup -- the same split-backend layout llama.cpp uses -- so a lone
       * binary starts and immediately fails to find a backend.
       */
      await rm(dir, { recursive: true, force: true });
      await makePrivateDir(join(dir, ".."));
      const { rename, cp } = await import("node:fs/promises");
      const sourceDir = join(found, "..");
      try {
        await rename(sourceDir, dir);
      } catch {
        // Different filesystems: copy instead. Slower, and always available.
        await cp(sourceDir, dir, { recursive: true });
      }

      const binary = join(dir, process.platform === "win32" ? "whisper-server.exe" : "whisper-server");
      if (process.platform !== "win32") await chmod(binary, 0o755);
      await this.update({ binary, tag: release.tag_name });
      return { tag: release.tag_name, binary };
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Fetch one Whisper model from the Hub.
   *
   * The checksum comes from the tree listing rather than being trusted from the
   * download, the same way model files are handled elsewhere: git-lfs records a
   * sha256 per file and it arrives from a different request than the bytes.
   */
  async installModel(
    file: string,
    signal?: AbortSignal,
    onProgress?: (p: Progress & { what: string }) => void,
  ): Promise<string> {
    const known = WHISPER_MODELS.find((m) => m.file === file);
    if (!known) throw new DownloadError(`${file} is not one of the models Karen offers.`);

    let sha: string | undefined;
    try {
      const res = await fetch(treeUrl(WHISPER_REPO), { ...(signal ? { signal } : {}) });
      if (res.ok) sha = parseTree(await res.json()).find((f) => f.path === file)?.sha256;
    } catch {
      // A checksum we could not fetch is not a reason to refuse the download;
      // it is a reason not to claim the download was verified.
    }

    const dest = join(modelsDir(), file);
    await downloadFile(downloadUrl(WHISPER_REPO, file), dest, {
      ...(sha ? { sha256: sha } : {}),
      ...(signal ? { signal } : {}),
      ...(onProgress ? { onProgress: (p: Progress) => onProgress({ ...p, what: known.label }) } : {}),
    });
    await this.rescanModels();
    await this.update({ modelPath: dest, modelFile: file });
    return dest;
  }

  async removeModel(file: string): Promise<void> {
    const path = join(modelsDir(), modelFileName(file));
    if (this.#config.modelPath === path) {
      await this.stop();
      await this.update({ modelPath: undefined, modelFile: undefined });
    }
    await rm(path, { force: true });
    await this.rescanModels();
  }

  async useModel(file: string): Promise<void> {
    const path = join(modelsDir(), modelFileName(file));
    if (!existsSync(path)) throw new Error(`${file} is not on this machine.`);
    // The running server has the old model mapped; it has to go.
    await this.stop();
    await this.update({ modelPath: path, modelFile: file });
  }

  /* ------------------------------------------------------------- server --- */

  /** Where to send audio, or undefined when this machine is not doing it. */
  endpoint(): { baseUrl: string } | undefined {
    if (!this.#config.useForTranscription) return undefined;
    if (this.#status.state !== "ready" || !this.#status.baseUrl) return undefined;
    return { baseUrl: this.#status.baseUrl };
  }

  /** True when a local server could be started if one were needed. */
  get ready(): boolean {
    return Boolean(this.#config.useForTranscription && this.#config.binary && this.#config.modelPath);
  }

  async start(): Promise<WhisperStatus> {
    if (this.#status.state === "ready") return this.#status;
    // Two meetings transcribed at once would otherwise spawn two servers on two
    // ports and leak one of them.
    this.#starting ??= this.#start().finally(() => {
      this.#starting = undefined;
    });
    return await this.#starting;
  }

  async #start(): Promise<WhisperStatus> {
    const { binary, modelPath } = this.#config;
    if (!binary) throw new Error("No transcription runtime is installed.");
    if (!modelPath) throw new Error("No transcription model has been downloaded.");

    await this.stop();
    this.#stopping = false;
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;

    /*
     * `--inference-path` is what makes this a drop-in.
     *
     * whisper-server serves `/inference` by default. Pointing it at
     * `/v1/audio/transcriptions` means every caller in the app -- dictation and
     * meetings alike -- talks to it with the same code that talks to a hosted
     * OpenAI-compatible endpoint, and nothing anywhere needs to know which it
     * is.
     */
    const args = [
      "-m", modelPath,
      "--host", "127.0.0.1",
      "--port", String(port),
      "--inference-path", "/v1/audio/transcriptions",
    ];

    this.#set({ state: "starting", baseUrl, error: undefined, log: [] });

    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // Not detached: it has to stay our child so that quitting can kill it.
      cwd: join(binary, ".."),
    });
    this.#child = child;
    this.#set({ pid: child.pid ?? undefined });

    const capture = (buf: Buffer): void => {
      for (const line of buf.toString().split(/\r?\n/)) if (line.trim()) this.#log(line);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    child.on("error", (err) => {
      this.#set({ state: "failed", error: `could not start whisper-server: ${err.message}` });
    });
    child.on("exit", (code, signal) => {
      this.#child = undefined;
      if (this.#stopping) {
        this.#set({ state: "stopped", pid: undefined });
        return;
      }
      this.#set({
        state: "failed",
        pid: undefined,
        error: `whisper-server stopped (${signal ? `signal ${signal}` : `exit code ${code}`}).`,
      });
    });

    await this.#waitForReady(port);
    return this.#status;
  }

  /**
   * Wait for the port to answer.
   *
   * whisper-server has no health endpoint; it serves its own small web page at
   * `/` once the model is loaded, so any HTTP answer at all means it is up. A
   * connection refused means it is still loading -- or has already died, which
   * the exit handler above will have recorded.
   */
  async #waitForReady(port: number): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.#status.state === "failed") throw new Error(this.#status.error ?? "whisper-server failed to start");
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (res.ok || res.status === 404) {
          this.#set({ state: "ready" });
          return;
        }
      } catch {
        // Not listening yet.
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    await this.stop();
    throw new Error("whisper-server did not become ready within two minutes.");
  }

  /**
   * Synchronous best effort, for `before-quit`.
   *
   * `stop()` awaits an orderly exit and `before-quit` cannot await anything, so
   * this is the version that runs when the window closes. Same reasoning as the
   * model server: a transcription process left holding a model after the app
   * has gone is the single most annoying thing a local-model app can do.
   */
  killNow(): void {
    const child = this.#child;
    if (!child || child.exitCode !== null) return;
    this.#stopping = true;
    if (process.platform === "win32" && child.pid) {
      // A terminated parent does not take its children with it on Windows.
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      child.kill("SIGKILL");
    }
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (!child) {
      if (this.#status.state !== "stopped") this.#set({ state: "stopped", pid: undefined });
      return;
    }
    this.#stopping = true;
    this.#child = undefined;
    await new Promise<void>((resolve) => {
      const done = setTimeout(() => {
        // It did not go quietly. A transcription server holding a model is not
        // something to leave behind.
        child.kill("SIGKILL");
        resolve();
      }, 4_000);
      child.once("exit", () => {
        clearTimeout(done);
        resolve();
      });
      child.kill();
    });
    this.#set({ state: "stopped", pid: undefined, baseUrl: undefined });
  }
}
