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
import { effectiveKind, parseProviders, type Provider } from "./providers.ts";
import { parseSampling, type Sampling } from "./llm/sampling.ts";
import { DEFAULT_REVIEW_PROMPT, DEFAULT_STUDY_TYPES, type StudyType } from "./review/prompt.ts";

/** Per-model sampler settings, each rebuilt field by field on the way in. */
function parseSamplingByModel(raw: unknown): Record<string, Sampling> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, Sampling> = {};
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = parseSampling(value);
    // An entry with nothing usable left in it is not an entry.
    if (Object.keys(parsed).length) out[model] = parsed;
  }
  return out;
}
/**
 * Model -> chosen level, keeping only what could be a level.
 *
 * Strings only, and short ones: these end up in a request field, and a
 * settings file edited by hand should not be a way to put an arbitrary
 * structure into one.
 */
function parseReasoningByModel(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value && value.length <= 32) out[model] = value;
  }
  return out;
}

import { CONFIG_DIR, makeOwnDir, OWNER_ONLY_FILE } from "./paths.ts";
import { isLocalHost } from "./destinations.ts";
import { DEFAULT_VOICE, voiceForModel } from "./audio/voices.ts";
import { DEFAULT_SIZE, sizeIsValid } from "./images/sizes.ts";

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

/**
 * The two audio models, and the voice one of them speaks in.
 *
 * Stored as REFERENCES rather than as endpoints, which is the whole of the
 * change this block represents. Transcription used to be a base URL, an API key
 * and a model name typed into a form -- a third way of configuring a model,
 * beside the local runtime and Providers, and the only one where a person had
 * to know that the thing on this machine answers at `/v1` and is called
 * `Whisper-Base` rather than `whisper-1`. A bare id here is a model the local
 * daemon runs; `provider::model` is one of the user's own providers. Exactly the
 * shape the chat model already uses, and for the same reason: it is the one
 * field that can answer both "which model" and "does this leave the machine".
 */
export interface AudioSettings {
  /** What turns speech into text, for dictation and for meetings. */
  transcriptionModel: string;
  /** What turns text into speech. Empty means Karen never speaks. */
  voiceModel: string;
  /** Which voice, for a model that has more than one. */
  voice: string;
  /** 0.5 to 2. Applied only when it is not 1, so a default sends no field. */
  speed: number;
  /**
   * Whether the chat screen is in the hands-free mode.
   *
   * Persisted deliberately. It is a toggle on the chat bar rather than a
   * settings row, but someone who talks to Karen talks to it every day, and a
   * mode that resets each launch is a mode that has to be switched on before
   * every conversation.
   */
  speechToSpeech: boolean;
}

/**
 * The image model, and how big to draw.
 *
 * A reference like the audio ones, for the same reason: one field that answers
 * both "which model" and "does this leave the machine". Everything else about
 * a generation -- the prompt, what to avoid, which preset -- belongs to the
 * generation and not to the settings, so it is not here.
 */
export interface ImageSettings {
  /** Empty means none is chosen and the page says so. */
  model: string;
  /** `512x512`. Empty is legal and lets the engine pick. */
  size: string;
}

export interface Settings {
  permissionMode: PermissionMode;
  /** Dark is the default; the whole palette is defined for both. */
  theme: Theme;
  llm: EndpointSettings;
  /** The two speech models and the voice. See AudioSettings. */
  audio: AudioSettings;
  /** The image model and its size. See ImageSettings. */
  image: ImageSettings;
  /**
   * The transcription endpoint as it was configured before `audio` existed.
   *
   * Present for one purpose: to be migrated away from. On the first launch
   * after the upgrade the main process turns a configured endpoint into an
   * ordinary provider -- which is what it always was -- moves its key across,
   * points `audio.transcriptionModel` at it, and clears this. Nothing else
   * reads it, and once it is empty it stays empty.
   *
   * Deleting the field outright was the alternative, and it would have silently
   * unconfigured transcription for anyone who had pointed Karen at their own
   * whisper server. A migration that runs once is cheaper than that surprise.
   */
  legacyTranscription?: EndpointSettings | undefined;
  /**
   * The embeddings endpoint, separate from the chat one.
   *
   * Usually a different server: llama.cpp serves a single model per process, so
   * the embedding model rarely shares a port with the chat model, and it
   * answers /embeddings rather than /chat/completions.
   */
  embeddings: EndpointSettings;
  /**
   * Where the user's Zotero library is, when Karen cannot work it out itself.
   *
   * Empty is the normal case and means "find it": Zotero's own profile is read
   * first, then the default locations. This field is for the library that is
   * on a second disk or in a synced folder, which is exactly the library a
   * researcher with twenty years of papers has -- and, before this existed,
   * the one Karen could only report as "Zotero does not appear to be
   * reachable", which is the message for an entirely different problem.
   *
   * A path, not a file: the folder holding zotero.sqlite.
   */
  zoteroDataDir: string;
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
  /** On the host: where generated images and their sidecars are kept. */
  imagesRoot: string;
  /** On the host: where the paper drafter keeps one JSON per paper. */
  papersRoot: string;
  /**
   * The project new work files itself into. Empty means none.
   *
   * A setting rather than window state because the main process is what has to
   * read it: a conversation, a paper, a meeting, an image and a research run
   * are all created down here, and each has to know where it belongs at the
   * moment it comes into existence.
   */
  activeProject: string;
  /**
   * The peer reviewer's own instructions, and one block per study design.
   *
   * Editable, unlike the paper drafter's prompt, and deliberately: a reviewer's
   * standards are their own, journals differ in what they ask for, and the
   * thing being protected here -- not inventing literature -- is stated in the
   * default text rather than enforced by hiding it. Set up once in Settings,
   * with a per-review note in the tab itself.
   */
  reviewPrompt: string;
  reviewStudyTypes: StudyType[];
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
  /**
   * Extra endpoints models can be served from, beyond the managed local one.
   *
   * Empty by default and empty for anyone who never adds one, which is the
   * point: Karen without providers is Karen as it was, with no route off the
   * machine at all.
   */
  providers: Provider[];
  /**
   * Sampler settings per model, keyed the way a model is chosen.
   *
   * Per model rather than global, because the right temperature for a 4B
   * instruct model is not the right temperature for a 70B one, and a single
   * slider would be re-tuned on every switch until it was abandoned.
   */
  sampling: Record<string, Sampling>;
  /**
   * How hard each model should think, in that endpoint's own vocabulary.
   *
   * Keyed by model for the same reason `sampling` is, and for one more: the
   * value only means anything inside one dialect. "high" is an OpenAI effort,
   * "-1" is a Google budget and "false" is a template variable, so a single
   * global setting would carry a value from one endpoint to another where it
   * is not a value at all. Anything that no longer matches the model's dialect
   * is dropped on read rather than sent.
   */
  reasoning: Record<string, string>;
}

export const DEFAULT_AUDIO: AudioSettings = {
  /* Empty rather than a name like `Whisper-Base`: a default naming a model that
     is not downloaded would make every fresh install fail its first dictation
     with "no such model" instead of saying that none has been chosen. */
  transcriptionModel: "",
  voiceModel: "",
  voice: DEFAULT_VOICE,
  speed: 1,
  speechToSpeech: false,
};

export const DEFAULT_IMAGE: ImageSettings = {
  /* Empty for the same reason DEFAULT_AUDIO is: a default naming a model that
     is not downloaded would make every fresh install fail its first
     generation with "no such model" instead of saying none has been chosen. */
  model: "",
  size: DEFAULT_SIZE,
};

/**
 * The image block, rebuilt field by field.
 *
 * The size is validated for SHAPE rather than against the offered list: the
 * three sizes in sizes.ts are what Karen shows, not what an engine accepts, and
 * a model that wants 1152x896 should not be overruled by a table. What is
 * rejected is a value that is not a size at all, which can only have come from
 * an edited file.
 */
function parseImage(raw: unknown): ImageSettings {
  const base = DEFAULT_IMAGE;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...base };
  const row = raw as Record<string, unknown>;
  const model = typeof row["model"] === "string" ? (row["model"] as string).trim().slice(0, 300) : base.model;
  const size = typeof row["size"] === "string" ? (row["size"] as string).trim().slice(0, 20) : base.size;
  return { model, size: sizeIsValid(size) ? size : base.size };
}

/**
 * The audio block, rebuilt field by field.
 *
 * The same discipline the providers list gets: these values are model names and
 * a voice that go straight into a request body, and a settings file is
 * something a person can edit. A number where a string belongs would otherwise
 * reach `JSON.stringify` and come back as a 400 nobody can trace to a file.
 */
function parseAudio(raw: unknown): AudioSettings {
  const base = DEFAULT_AUDIO;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...base };
  const row = raw as Record<string, unknown>;
  const text = (key: string, fallback: string): string =>
    typeof row[key] === "string" ? (row[key] as string).trim().slice(0, 300) : fallback;
  const speed = Number(row["speed"]);
  const voiceModel = text("voiceModel", base.voiceModel);
  return {
    transcriptionModel: text("transcriptionModel", base.transcriptionModel),
    voiceModel,
    /* Reconciled with the model, not merely read. The two are set from
       different screens -- the model from the chat bar or the Audio pane, the
       voice from the Audio pane alone -- so a voice left over from the
       previous engine would otherwise be sent to one that has never heard of
       it, and every answer would fail with a bare 500. */
    voice: voiceForModel(voiceModel, text("voice", base.voice)),
    /* Clamped rather than trusted. Kokoro accepts a `speed` it cannot honour
       and returns audio nobody can follow; the slider stops at these bounds,
       so anything outside them came from a file. */
    speed: Number.isFinite(speed) && speed >= 0.5 && speed <= 2 ? speed : base.speed,
    speechToSpeech: row["speechToSpeech"] === true,
  };
}

/**
 * The pre-`audio` transcription endpoint, read from the key the old build wrote.
 *
 * Typed as unknown and dug out by hand because `transcription` is no longer
 * part of Settings: this is the one place that still knows the name, which is
 * what a migration source should look like. An endpoint with no base URL was
 * never configured and is not worth migrating.
 */
function legacyEndpoint(raw: unknown): EndpointSettings | undefined {
  const row = (raw as Record<string, unknown> | null)?.["transcription"];
  if (!row || typeof row !== "object") return undefined;
  const stored = row as Partial<EndpointSettings>;
  if (typeof stored.baseUrl !== "string" || !stored.baseUrl.trim()) return undefined;
  return endpoint(
    { baseUrl: "", envVar: "KAREN_TRANSCRIPTION_KEY", model: "whisper-1", timeoutMs: 120_000 },
    stored,
  );
}

export const DEFAULT_SETTINGS: Settings = {
  permissionMode: "guarded",
  theme: "dark",
  llm: { baseUrl: "", envVar: "KAREN_LLM_KEY", timeoutMs: 120_000 },
  audio: { ...DEFAULT_AUDIO },
  image: { ...DEFAULT_IMAGE },
  embeddings: { baseUrl: "", envVar: "KAREN_EMBED_KEY", model: "", timeoutMs: 120_000 },
  zoteroDataDir: "",
  workspaceRoot: join(homedir(), "Documents", "karen"),
  vaultRoot: "",
  vaultWriteSubdir: "Karen",
  dictationHotkey: "<Super>d",
  dictationSource: "",
  dictationLanguage: "",
  deleteRawAudioAfterTranscription: false,
  meetingsRoot: join(homedir(), "Documents", "karen", "meetings"),
  imagesRoot: join(homedir(), "Documents", "karen", "images"),
  papersRoot: join(homedir(), "Documents", "karen", "papers"),
  activeProject: "",
  reviewPrompt: DEFAULT_REVIEW_PROMPT,
  /* Copied, not shared: these are edited in place by the settings pane, and a
     default array handed out by reference would be edited for every future
     reader of the module too. */
  reviewStudyTypes: DEFAULT_STUDY_TYPES.map((t) => ({ ...t })),
  meetingReportDir: "Meetings",
  meetingCaptureSystemAudio: true,
  meetingInstructions: "",
  keepRunningInTray: true,
  setupCompleted: false,
  providers: [],
  sampling: {},
  reasoning: {},
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
      const parsed = JSON.parse(raw) as Partial<Settings> & Record<string, unknown>;
      /*
       * The old key is taken OUT of what gets spread, not merely read from it.
       *
       * `...parsed` copies whatever is in the file, including keys `Settings`
       * no longer declares -- TypeScript drops them from the type and nothing
       * drops them from the object. So `transcription` survived the load, was
       * written back out by the next save, and was lifted into
       * `legacyTranscription` again on the launch after that: the migration ran
       * every single time, minting another "Transcription (imported)" provider
       * on each one. Caught by the test that asserts the migration's own effect
       * is what stops it repeating.
       */
      const { transcription: _migrated, ...stored } = parsed;
      this.#settings = {
        ...DEFAULT_SETTINGS,
        ...stored,
        llm: endpoint(DEFAULT_SETTINGS.llm, parsed.llm),
        /* Field by field, like the providers list and for the same reason: a
           settings file is something a person can edit, and a voice or a model
           reference read straight out of it would be sent to an endpoint. */
        audio: parseAudio(parsed.audio),
        image: parseImage(parsed.image),
        /* Read from the key the old build wrote. `transcription` is not part of
           Settings any more, so this is the only thing that still knows the
           name -- which is exactly what a migration source should be. */
        legacyTranscription: legacyEndpoint(parsed),
        // Merged per key like the others: a settings file written before this
        // endpoint existed, or holding only a baseUrl, would otherwise drop
        // envVar and leave the key with nowhere to arrive.
        embeddings: endpoint(DEFAULT_SETTINGS.embeddings, parsed.embeddings),
        /* Rebuilt from the file rather than spread, because this list decides
           where conversations are sent: a half-formed entry must not become a
           route. */
        providers: parseProviders(parsed.providers),
        sampling: parseSamplingByModel(parsed.sampling),
        reasoning: parseReasoningByModel(parsed.reasoning),
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
      /* Merged, so the chat bar can change the voice model without having to
         send the voice and the speed back with it. */
      ...(patch.audio ? { audio: parseAudio({ ...this.#settings.audio, ...patch.audio }) } : {}),
      /* Merged too, so the image bar can change the model without sending the
         size back with it. */
      ...(patch.image ? { image: parseImage({ ...this.#settings.image, ...patch.image }) } : {}),
      /* `undefined` is a value here, not an omission: clearing this is how the
         migration records that it is done, and a spread that skipped it would
         run the migration again on every launch. */
      ...("legacyTranscription" in patch ? { legacyTranscription: patch.legacyTranscription } : {}),
      // Replaced wholesale, not merged: removing a provider is a thing the user
      // must be able to do, and a merge cannot express a deletion.
      ...(patch.providers ? { providers: parseProviders(patch.providers) } : {}),
      ...(patch.sampling ? { sampling: parseSamplingByModel(patch.sampling) } : {}),
      /* Replaced, not merged: un-choosing a level has to be expressible, and
         a merge cannot say "this model no longer has one". */
      ...(patch.reasoning ? { reasoning: parseReasoningByModel(patch.reasoning) } : {}),
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
  add("Embeddings", settings.embeddings.baseUrl);
  /* Providers belong here for the same reason the three above do, and more
     urgently: a privacy report that listed only the built-in endpoints while a
     hosted provider sat configured would be a report that is wrong about
     exactly the thing it exists to be right about. */
  for (const provider of settings.providers) {
    if (!provider.enabled || !provider.baseUrl.trim()) continue;
    /* effectiveKind, not the address alone.
       A loopback provider the user has deliberately marked external is treated
       as external everywhere else in the app -- the picker warns about it, and
       the llama.cpp-only samplers are withheld from it. A report calling that
       same provider "local" would be the app giving two answers to its one
       important question. The dangerous direction was already safe: a remote
       address never reads as local whatever the label says. */
    rows.push({
      label: `Models — ${provider.label || provider.baseUrl}`,
      url: provider.baseUrl,
      local: effectiveKind(provider) === "local",
    });
  }
  return rows;
}
