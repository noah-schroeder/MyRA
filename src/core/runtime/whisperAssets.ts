/**
 * Choosing a whisper.cpp build, and a Whisper model to feed it.
 *
 * Why this exists at all, verified rather than assumed by reading both
 * binaries:
 *
 *   - **llama-server does have `/v1/audio/transcriptions`, and it cannot do
 *     this job.** Its own strings give it away: "Request converted: OpenAI
 *     Transcriptions -> OpenAI Chat Completions", "audio input is not supported
 *     - hint: ... you may need to provide the mmproj", and decisively "Only
 *     'json' response_format is supported for transcription". It is a shim onto
 *     an audio-capable chat model, and it returns no segment timestamps.
 *   - **A meeting needs timestamps.** Karen records two tracks -- the
 *     microphone and the system's output -- and interleaves them by time.
 *     Without `verbose_json` there is nothing to interleave, which is why the
 *     pipeline already refuses rather than producing a transcript with the two
 *     halves of a conversation in the wrong order.
 *   - **whisper-server returns them**, and takes `--inference-path`, so
 *     `--inference-path /v1/audio/transcriptions` puts it at exactly the path
 *     the app already posts to. No special-casing anywhere else.
 *
 * The release feed is messier than llama.cpp's. Tags alternate between
 * `v1.9.2` and `b4938` with no pattern, and a release can carry no assets at
 * all (v1.9.3, a prerelease, carries none). So the newest release is the newest
 * one that actually has a build for this machine, not the newest tag.
 */

import type { Release, ReleaseAsset } from "./assets.ts";

/** Which whisper.cpp build, in the sense of what it is compiled against. */
export type WhisperBackend = "cpu" | "cuda";

export interface WhisperTarget {
  platform: string;
  arch: string;
  backend?: WhisperBackend;
}

/**
 * The asset for this machine, or undefined where upstream publishes none.
 *
 * macOS is the gap: whisper.cpp ships an `xcframework` for embedding in an
 * Xcode project and no command-line build at all, so there is nothing here to
 * download for a Mac. That is stated as a fact rather than papered over with a
 * guess -- see `whisperUnavailable`.
 */
export function whisperAsset(
  assets: ReleaseAsset[],
  target: WhisperTarget,
): ReleaseAsset | undefined {
  const find = (re: RegExp): ReleaseAsset | undefined => {
    const matches = assets.filter((a) => re.test(a.name));
    if (matches.length <= 1) return matches[0];
    // Several CUDA toolchains ship together; the newest wins, as it does for
    // llama.cpp.
    return [...matches].sort((a, b) => b.name.localeCompare(a.name, "en", { numeric: true }))[0];
  };

  if (target.platform === "linux") {
    // Upstream publishes only CPU builds for Linux -- no vulkan, no cuda.
    // Rechecked at b4938.
    return find(target.arch === "arm64" ? /^whisper-bin-ubuntu-arm64\.tar\.gz$/ : /^whisper-bin-ubuntu-x64\.tar\.gz$/);
  }

  if (target.platform === "win32") {
    if (target.arch !== "x64") return undefined;
    if (target.backend === "cuda") {
      // 257 MB or 640 MB depending on toolchain, against 8 MB for CPU. Offered
      // only where an NVIDIA card was actually found.
      return find(/^whisper-cublas-[\d.]+-bin-x64\.zip$/);
    }
    return find(/^whisper-bin-x64\.zip$/);
  }

  return undefined;
}

/** Why there is nothing to download here, in words a user can act on. */
export function whisperUnavailable(platform: string, arch: string): string | undefined {
  if (platform === "darwin") {
    return (
      "whisper.cpp publishes no ready-to-run build for macOS — only a framework meant to be " +
      "compiled into an Xcode project. Install it with `brew install whisper-cpp` and point " +
      "Karen at it, or use any other transcription endpoint."
    );
  }
  if (platform === "linux" || platform === "win32") {
    return arch === "arm64" && platform === "win32"
      ? "whisper.cpp publishes no Windows build for this processor."
      : undefined;
  }
  return `whisper.cpp publishes no build for ${platform}.`;
}

/**
 * The newest release carrying a build for this machine.
 *
 * Not `releases/latest`, and not the newest tag either. Tags alternate between
 * `v1.9.2` and `b4938` with nothing to sort on, and prereleases can carry no
 * assets at all. Publication date is the one field that means the same thing in
 * every release, so it is what this sorts by -- and having a usable asset is
 * part of what "newest" has to mean, or the answer is a release you cannot
 * install.
 */
export function newestWhisperRelease(
  releases: Release[],
  target: WhisperTarget,
): Release | undefined {
  return [...releases]
    .filter((r) => !r.draft && whisperAsset(r.assets ?? [], target) !== undefined)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
}

/* ------------------------------------------------------------- models --- */

/**
 * The Whisper models worth offering, and what each costs.
 *
 * A curated shortlist rather than the repository's full 33 files, because most
 * of those are variations nobody should have to reason about: this leaves out
 * large-v1 and large-v2, which large-v3 supersedes, and the unquantised copies
 * of models whose q5 version is materially identical and a third of the size.
 *
 * `.en` models are English-only and measurably better at English than the
 * multilingual model of the same size, which is worth saying rather than
 * leaving as a filename suffix.
 *
 * Sizes are the real ones from `ggerganov/whisper.cpp` on the Hub, read while
 * this was written. They are shown to the user, so they are not estimates.
 */
export const WHISPER_REPO = "ggerganov/whisper.cpp";

export interface WhisperModel {
  file: string;
  label: string;
  bytes: number;
  /** Whether it handles languages other than English. */
  multilingual: boolean;
  /** One line on when this is the right choice. */
  hint: string;
}

const MB = 1024 * 1024;

export const WHISPER_MODELS: readonly WhisperModel[] = [
  {
    file: "ggml-base.en-q5_1.bin",
    label: "Base (English)",
    bytes: 57 * MB,
    multilingual: false,
    hint: "Fast enough on any machine. Good for a clear one-to-one call.",
  },
  {
    file: "ggml-small.en-q5_1.bin",
    label: "Small (English)",
    bytes: 181 * MB,
    multilingual: false,
    hint: "The sensible default: noticeably better on accents and crosstalk.",
  },
  {
    file: "ggml-small-q5_1.bin",
    label: "Small (multilingual)",
    bytes: 181 * MB,
    multilingual: true,
    hint: "Same size and speed, for meetings that are not in English.",
  },
  {
    file: "ggml-medium.en-q5_0.bin",
    label: "Medium (English)",
    bytes: 514 * MB,
    multilingual: false,
    hint: "Better again on difficult audio. Slower on a processor.",
  },
  {
    file: "ggml-large-v3-turbo-q5_0.bin",
    label: "Large v3 turbo",
    bytes: 547 * MB,
    multilingual: true,
    hint: "The most accurate that is still practical, in every language.",
  },
] as const;

/** The one to suggest, given how much memory the machine has. */
export function suggestWhisperModel(ramBytes: number): WhisperModel {
  const small = WHISPER_MODELS.find((m) => m.file === "ggml-small.en-q5_1.bin")!;
  const base = WHISPER_MODELS.find((m) => m.file === "ggml-base.en-q5_1.bin")!;
  return ramBytes >= 8 * 1024 * MB ? small : base;
}
