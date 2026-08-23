/**
 * Turning per-track transcriptions into one conversation.
 *
 * Two jobs, both in service of notes that can be trusted:
 *
 *  1. Interleave the tracks by time, so the transcript reads as a conversation
 *     rather than as two monologues.
 *  2. Remove acoustic bleed. This one matters more than it sounds: if the
 *     meeting is on speakers rather than headphones, the microphone records
 *     everyone else as well, and the transcript ends up saying everything
 *     twice -- once attributed correctly and once attributed to you. Notes
 *     built on that are worse than notes built on a single track, so
 *     dual-track capture is only an improvement if this step works.
 */

import type { Segment } from "./stt.ts";

export interface TrackTranscript {
  id: string;
  label: string;
  segments: Segment[];
}

export interface Line {
  /** Seconds from the start of the meeting. */
  at: number;
  end: number;
  speaker: string;
  trackId: string;
  text: string;
}

export interface MergeOptions {
  /**
   * Track whose version of a duplicated passage is kept.
   *
   * The sink monitor, normally: it is a clean digital copy of what the remote
   * participants said, whereas the microphone's copy of the same words has been
   * through a speaker and a room.
   */
  authoritative?: string;
  /** Word overlap above which two lines are treated as the same speech. */
  threshold?: number;
}

/**
 * Words worth comparing, with punctuation and casing thrown away.
 *
 * Apostrophes are deleted rather than treated as separators, so "I'll" becomes
 * one word and not two. This is not pedantry: the transcriber writes a curly
 * apostrophe, a model quoting it back frequently writes a straight one or none
 * at all, and splitting on them would make a quote fail to match the very line
 * it was copied from.
 */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0027\u2018\u2019\u02bc]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
}

/**
 * How much of the shorter passage appears in the longer one.
 *
 * Containment rather than Jaccard: bleed is usually a partial, degraded copy --
 * a few words of a longer sentence -- and Jaccard would score that low for
 * exactly the wrong reason.
 */
export function similarity(a: string, b: string): number {
  const left = new Set(words(a));
  const right = new Set(words(b));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / Math.min(left.size, right.size);
}

function overlaps(a: Line, b: Line): boolean {
  return a.at < b.end && b.at < a.end;
}

/**
 * Interleave tracks into one transcript, dropping bleed.
 *
 * Only passages of five words or more are considered duplicates. Two people
 * both saying "yeah, exactly" at the same moment is a real thing that happens
 * in meetings, and deleting one of them would be inventing a silence.
 */
export function mergeTracks(tracks: TrackTranscript[], options: MergeOptions = {}): Line[] {
  const { authoritative, threshold = 0.6 } = options;

  const lines: Line[] = [];
  for (const track of tracks) {
    for (const segment of track.segments) {
      const text = segment.text.trim();
      if (!text) continue;
      lines.push({ at: segment.start, end: segment.end, speaker: track.label, trackId: track.id, text });
    }
  }
  lines.sort((a, b) => a.at - b.at || a.trackId.localeCompare(b.trackId));

  const dropped = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (dropped.has(i)) continue;
    const line = lines[i]!;
    if (words(line.text).length < 5) continue;

    for (let j = i + 1; j < lines.length; j++) {
      const other = lines[j]!;
      // Sorted by time: once a line starts after this one ends, so does the rest.
      if (other.at >= line.end) break;
      if (dropped.has(j) || other.trackId === line.trackId) continue;
      if (!overlaps(line, other) || words(other.text).length < 5) continue;
      if (similarity(line.text, other.text) < threshold) continue;

      // Keep the authoritative track's copy; failing that, the longer one,
      // which is the less degraded transcription of the same speech.
      const keepOther = authoritative
        ? other.trackId === authoritative
        : words(other.text).length > words(line.text).length;
      if (keepOther) {
        dropped.add(i);
        break;
      }
      dropped.add(j);
    }
  }

  return lines.filter((_, i) => !dropped.has(i));
}

/**
 * Join consecutive lines from one speaker into a paragraph.
 *
 * Whisper segments every few seconds, which shreds a single answer into a dozen
 * lines. Joined they read as speech and quote as speech -- but only while the
 * speaker holds the floor, so a run is broken by anyone else talking, by a gap,
 * or by growing long enough to be hard to point at.
 */
export function joinRuns(lines: Line[], maxGap = 2, maxChars = 600): Line[] {
  const out: Line[] = [];
  for (const line of lines) {
    const previous = out[out.length - 1];
    if (
      previous &&
      previous.trackId === line.trackId &&
      line.at - previous.end <= maxGap &&
      previous.text.length + line.text.length + 1 <= maxChars
    ) {
      previous.text = `${previous.text} ${line.text}`.replace(/\s+/g, " ").trim();
      previous.end = line.end;
      continue;
    }
    out.push({ ...line });
  }
  return out;
}

/** Seconds as hh:mm:ss, so a note can point at a moment in the recording. */
export function timecode(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export interface FormatOptions {
  /**
   * Label each line with its track.
   *
   * Off by default. Two tracks are recorded so that everyone in a remote
   * meeting is actually captured -- a microphone alone records the person
   * wearing the headphones and nobody else -- but "Me" and "Everyone else" is
   * not speaker identification, and printing it invites the model to reason
   * about who said what on evidence that does not support it.
   */
  speakers?: boolean;
}

/** The transcript as the model and the reader both see it. */
export function formatTranscript(lines: Line[], options: FormatOptions = {}): string {
  return lines
    .map((line) =>
      options.speakers
        ? `[${timecode(line.at)}] ${line.speaker}: ${line.text}`
        : `[${timecode(line.at)}] ${line.text}`,
    )
    .join("\n");
}

export interface QuoteMatch {
  line: Line;
  /** True when the quote appears verbatim; false when it only mostly matches. */
  exact: boolean;
  score: number;
}

/**
 * Find the transcript line a quoted claim came from.
 *
 * This is what makes an action item checkable rather than plausible. A model
 * asked to quote its source will occasionally produce a quote that is not in
 * the transcript at all, and that is precisely the item you must not act on --
 * so every quote is looked up, and one that cannot be found is reported as
 * unverified rather than shown as if it were sourced.
 */
export function verifyQuote(lines: Line[], quote: string, threshold = 0.7): QuoteMatch | undefined {
  const needle = words(quote);
  if (needle.length === 0) return undefined;
  const joined = needle.join(" ");

  let best: QuoteMatch | undefined;
  for (const line of lines) {
    if (words(line.text).join(" ").includes(joined)) return { line, exact: true, score: 1 };
  }

  // Nothing verbatim. The notes prompt asks for verbatim quotes, so a near miss
  // means the model reconstructed the line instead of copying it -- worth
  // finding and showing, but never worth calling sourced.
  //
  // Short quotes are held to verbatim only: "yes" has high word overlap with
  // half the transcript, and matching it would source an item to a line
  // chosen essentially at random.
  if (needle.length < 4) return undefined;

  for (const line of lines) {
    const score = similarity(quote, line.text);
    if (score >= threshold && (!best || score > best.score)) best = { line, exact: false, score };
  }
  return best;
}
