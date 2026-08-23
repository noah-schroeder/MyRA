/**
 * All application settings, owned by the main process and edited only through
 * the GUI. The user should never have to open a JSON file -- that is a product
 * requirement, so anything configurable belongs in this shape.
 *
 * Note what is absent: API keys. Those live in the keyring (see secrets.ts);
 * this file records only the non-secret shape of an endpoint.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { PermissionMode } from "./policy.ts";
import { CONFIG_DIR } from "./paths.ts";

const SETTINGS_PATH = join(CONFIG_DIR, "settings.json");

export interface EndpointSettings {
  baseUrl: string;
  /** Env var name the key is exposed as, e.g. KAREN_LLM_KEY. */
  envVar: string;
  model?: string;
  timeoutMs: number;
}

export interface Settings {
  bridgePort: number;
  permissionMode: PermissionMode;
  llm: EndpointSettings;
  transcription: EndpointSettings;
  /**
   * The embeddings endpoint, separate from the chat one.
   *
   * Usually a different server: llama.cpp serves a single model per process, so
   * the embedding model rarely shares a port with the chat model, and it
   * answers /embeddings rather than /chat/completions.
   */
  embeddings: EndpointSettings;
  /** Inside the VM: where the agent may write freely. */
  workspaceRoot: string;
  /** On the host: the Obsidian vault, and the subtree the agent may write to. */
  vaultRoot: string;
  vaultWriteSubdir: string;
  dictationHotkey: string;
  /** PipeWire node id or name to record from. Empty means the system default. */
  dictationSource: string;
  /** ISO-639-1 hint for the transcriber. Empty lets it detect the language. */
  dictationLanguage: string;
  /** Delete raw meeting audio once it has been transcribed. */
  deleteRawAudioAfterTranscription: boolean;
  /** On the host: where meeting recordings are kept. */
  meetingsRoot: string;
  /** Vault-relative directory the meeting notes are filed in. */
  meetingReportDir: string;
  /**
   * Also record the system's output, not only the microphone.
   *
   * On by default, and it is not about identifying speakers: a microphone alone
   * records the person wearing the headphones and nobody else, so without this
   * a remote meeting transcribes to one side of the conversation.
   */
  meetingCaptureSystemAudio: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  bridgePort: 8765,
  permissionMode: "guarded",
  llm: { baseUrl: "", envVar: "KAREN_LLM_KEY", timeoutMs: 120_000 },
  transcription: { baseUrl: "", envVar: "KAREN_TRANSCRIPTION_KEY", model: "whisper-1", timeoutMs: 120_000 },
  embeddings: { baseUrl: "", envVar: "KAREN_EMBED_KEY", model: "", timeoutMs: 120_000 },
  workspaceRoot: join(homedir(), "Documents", "karen"),
  vaultRoot: "",
  vaultWriteSubdir: "Karen",
  dictationHotkey: "<Super>d",
  dictationSource: "",
  dictationLanguage: "",
  deleteRawAudioAfterTranscription: false,
  meetingsRoot: join(homedir(), "Documents", "karen", "meetings"),
  meetingReportDir: "Meetings",
  meetingCaptureSystemAudio: true,
};

export class ConfigStore {
  #settings: Settings = { ...DEFAULT_SETTINGS };
  #listeners = new Set<(s: Settings) => void>();

  get current(): Settings {
    return this.#settings;
  }

  onChange(fn: (s: Settings) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  async load(): Promise<Settings> {
    try {
      const raw = await readFile(SETTINGS_PATH, "utf8");
      const parsed = JSON.parse(raw) as Partial<Settings>;
      this.#settings = {
        ...DEFAULT_SETTINGS,
        ...parsed,
        llm: { ...DEFAULT_SETTINGS.llm, ...parsed.llm },
        transcription: { ...DEFAULT_SETTINGS.transcription, ...parsed.transcription },
        // Merged per key like the others: a settings file written before this
        // endpoint existed, or holding only a baseUrl, would otherwise drop
        // envVar and leave the key with nowhere to arrive.
        embeddings: { ...DEFAULT_SETTINGS.embeddings, ...parsed.embeddings },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    this.#emit();
    return this.#settings;
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    this.#settings = {
      ...this.#settings,
      ...patch,
      llm: { ...this.#settings.llm, ...patch.llm },
      transcription: { ...this.#settings.transcription, ...patch.transcription },
    };
    await this.save();
    this.#emit();
    return this.#settings;
  }

  async save(): Promise<void> {
    await mkdir(CONFIG_DIR, { recursive: true });
    const tmp = `${SETTINGS_PATH}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.#settings, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, SETTINGS_PATH);
  }

  #emit(): void {
    for (const fn of this.#listeners) fn(this.#settings);
  }

  /**
   * The complete set of origins the app itself may contact. Everything the
   * egress filter permits comes from here, so the allowlist is always derived,
   * never hand-maintained.
   *
   * The LLM endpoint is deliberately NOT included: pi reaches it from inside the
   * VM, and the host app has no reason to.
   */
  /**
   * Origins the app itself may reach.
   *
   * Derived from the user's own endpoint settings; there is no hand-maintained
   * list anywhere. The LLM endpoint is here because meeting notes are written
   * on the host: the transcript is private, and the VM is the machine that
   * fetches arbitrary web pages, so sending meeting transcripts there to be
   * summarised would move private data towards the less trusted side.
   */
  egressAllowlist(): string[] {
    const llm = this.#settings.llm.baseUrl;
    return [
      this.#settings.transcription.baseUrl,
      llm,
      // The same server as the app itself reaches it: the setting is the VM's
      // view, and a host-originated call goes to loopback instead.
      llm ? llm : "",
    ].filter(Boolean);
  }
}
