/**
 * All application settings, owned by the main process and edited only through
 * the GUI. The user should never have to open a JSON file -- that is a product
 * requirement, so anything configurable belongs in this shape.
 *
 * Note what is absent: API keys. Those live in the keyring (see secrets.ts);
 * this file records only the non-secret shape of an endpoint.
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { PermissionMode } from "./policy.ts";
import { CONFIG_DIR, makeOwnDir, OWNER_ONLY_FILE } from "./paths.ts";
import { isLocalHost } from "./destinations.ts";

const SETTINGS_PATH = join(CONFIG_DIR, "settings.json");

export interface EndpointSettings {
  baseUrl: string;
  /** Env var name the key is exposed as, e.g. KAREN_LLM_KEY. */
  envVar: string;
  model?: string;
  /**
   * How long to wait WITHOUT PROGRESS before giving up.
   *
   * Silence, not total duration. A streaming reply that takes ten minutes to
   * write is not late, it is long, and the previous reading of this field cut
   * exactly those answers off mid-sentence -- see `idleDeadline` in llm/chat.ts.
   */
  timeoutMs: number;
}

export type Theme = "dark" | "light";

export interface Settings {
  permissionMode: PermissionMode;
  /** Dark is the default; the whole palette is defined for both. */
  theme: Theme;
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
  /**
   * The default steer for meeting notes, used when a meeting has none of its own.
   *
   * Not the whole prompt: the extraction and composition prompts are long,
   * carefully argued, and not something to hand a user a textarea for. This is
   * the paragraph that says what *this* person's meetings are like -- "we are a
   * research group, keep the methodological objections" -- and it is appended
   * to both stages. Empty is the normal case.
   */
  meetingInstructions: string;
  /**
   * Whether first-run setup has been through once.
   *
   * Not "is everything installed": someone who deliberately skipped the model
   * runtime should not be met by the same screen every launch. It records that
   * the offer was made.
   */
  /**
   * Closing the window leaves Karen running in the tray.
   *
   * On, because the case that motivates it is the one where a window is
   * actively in the way: another app is using Karen's API, and closing the
   * window should not take the model and the gateway down with it.
   *
   * Ignored when no tray icon could be created -- on a desktop with no status
   * area the window closes normally, because an application you cannot see and
   * cannot reach is worse than one that quit when you did not mean it to.
   */
  keepRunningInTray: boolean;
  setupCompleted: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  permissionMode: "guarded",
  theme: "dark",
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
  meetingInstructions: "",
  keepRunningInTray: true,
  setupCompleted: false,
};

/**
 * The shortest timeout the app will honour, whatever the file says.
 *
 * The Settings field is in seconds and clamps at 5, so anything below this
 * cannot have been produced by the UI -- but a file written by an older build
 * can hold it, and this one did: a stored `timeoutMs: 1000` gave every request
 * a one-second deadline, which a real model cannot meet and which presents as
 * "the endpoint did not answer" rather than as a setting.
 */
const MIN_TIMEOUT_MS = 5_000;

/**
 * Merge one stored endpoint over its defaults, refusing values the UI could
 * not have written. The same shape of coercion the research category already
 * does: a stored value that is out of range is a bug to absorb on read, not
 * something to hand to the rest of the app.
 */
function endpoint(base: EndpointSettings, stored?: Partial<EndpointSettings>): EndpointSettings {
  const merged = { ...base, ...stored };
  const timeout = Number(merged.timeoutMs);
  return {
    ...merged,
    timeoutMs: Number.isFinite(timeout) && timeout >= MIN_TIMEOUT_MS ? timeout : base.timeoutMs,
  };
}

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
        llm: endpoint(DEFAULT_SETTINGS.llm, parsed.llm),
        transcription: endpoint(DEFAULT_SETTINGS.transcription, parsed.transcription),
        // Merged per key like the others: a settings file written before this
        // endpoint existed, or holding only a baseUrl, would otherwise drop
        // envVar and leave the key with nowhere to arrive.
        embeddings: endpoint(DEFAULT_SETTINGS.embeddings, parsed.embeddings),
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
    await makeOwnDir(CONFIG_DIR);
    const tmp = `${SETTINGS_PATH}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.#settings, null, 2) + "\n", { mode: OWNER_ONLY_FILE });
    await rename(tmp, SETTINGS_PATH);
  }

  #emit(): void {
    for (const fn of this.#listeners) fn(this.#settings);
  }
}

/**
 * The endpoints the user pointed Karen at, described honestly.
 *
 * This replaced an `egressAllowlist()` that nothing called: it described a
 * default-deny filter that was never installed, which made it worse than
 * absent -- a privacy claim the code did not keep. The filter now exists (see
 * `onBeforeRequest` in main/index.ts) and applies to the window, which makes
 * no requests at all; these endpoints are contacted from the main process, and
 * where they point is the user's decision rather than something to enforce.
 *
 * The only judgement made here is local versus not, because that is the line
 * that decides whether a prompt leaves the machine.
 */
export function configuredEndpoints(
  settings: Settings,
): { label: string; url: string; local: boolean }[] {
  const rows: { label: string; url: string; local: boolean }[] = [];
  const add = (label: string, url: string): void => {
    if (!url.trim()) return;
    let local = false;
    try {
      local = isLocalHost(new URL(url).hostname);
    } catch {
      /* An unparseable URL cannot be called local. */
    }
    rows.push({ label, url, local });
  };
  add("Chat and reasoning", settings.llm.baseUrl);
  add("Transcription", settings.transcription.baseUrl);
  add("Embeddings", settings.embeddings.baseUrl);
  return rows;
}
