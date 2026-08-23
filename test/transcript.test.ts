import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDetailed } from "../src/core/stt.ts";
import {
  formatTranscript, joinRuns, mergeTracks, similarity, timecode, verifyQuote, type Line,
} from "../src/core/meetings/transcript.ts";

const me = (start: number, end: number, text: string) => ({ start, end, text });

test("verbose_json is read, and a server that half-implements it still works", () => {
  const full = parseDetailed(JSON.stringify({
    text: "Hello there. General Kenobi.",
    language: "en",
    duration: 4.2,
    segments: [
      { id: 0, seek: 0, start: 0, end: 1.5, text: " Hello there." },
      { id: 1, seek: 0, start: 1.5, end: 4.2, text: " General Kenobi." },
    ],
  }));
  assert.equal(full.segments.length, 2);
  assert.equal(full.segments[0]!.text, "Hello there.");
  assert.equal(full.language, "en");
  assert.equal(full.duration, 4.2);

  // No segments: still usable, just not interleavable.
  const flat = parseDetailed(JSON.stringify({ text: "just text" }));
  assert.equal(flat.text, "just text");
  assert.deepEqual(flat.segments, []);

  // Not JSON at all, from a server that ignored response_format.
  assert.deepEqual(parseDetailed("  plain text reply  "), { text: "plain text reply", segments: [] });

  // Segments present but text missing: rebuild the text rather than fail.
  const rebuilt = parseDetailed(JSON.stringify({ segments: [me(0, 1, "one"), me(1, 2, "two")] }));
  assert.equal(rebuilt.text, "one two");
});

test("segments that are malformed are skipped, not turned into zeros", () => {
  const parsed = parseDetailed(JSON.stringify({
    text: "kept",
    segments: [
      { start: 0, end: 1, text: "kept" },
      { start: "nonsense", end: 2, text: "dropped" },
      { start: 3, end: 4, text: "   " },
      // An end before its start would sort wrongly and read as a negative span.
      { start: 9, end: 5, text: "repaired" },
    ],
  }));
  assert.deepEqual(parsed.segments.map((s: { text: string }) => s.text), ["kept", "repaired"]);
  assert.equal(parsed.segments[1]!.end, 9);
});

test("tracks interleave into one conversation", () => {
  const lines = mergeTracks([
    { id: "me", label: "Me", segments: [me(0, 3, "Shall we start with the roadmap?"), me(9, 12, "Agreed.")] },
    { id: "them", label: "Everyone else", segments: [me(3.5, 8, "Yes, and I will own the migration.")] },
  ]);
  assert.deepEqual(lines.map((l) => l.speaker), ["Me", "Everyone else", "Me"]);
  // By default the transcript carries no speaker labels: two tracks exist so
  // that everyone present is captured, not to identify who spoke.
  assert.equal(
    formatTranscript(lines),
    "[00:00:00] Shall we start with the roadmap?\n" +
    "[00:00:03] Yes, and I will own the migration.\n" +
    "[00:00:09] Agreed.",
  );
  assert.match(formatTranscript(lines, { speakers: true }), /\[00:00:00\] Me: Shall we/);
});

test("speaker bleed is removed, keeping the clean copy", () => {
  // On speakers, the microphone hears the remote participants too. Without this
  // the transcript says everything twice and attributes half of it to the wrong
  // person -- which is worse than not separating speakers at all.
  const lines = mergeTracks(
    [
      {
        id: "me",
        label: "Me",
        segments: [me(4, 8, "i will own the migration and report back friday")],
      },
      {
        id: "them",
        label: "Everyone else",
        segments: [me(3.8, 8.2, "I will own the migration and report back on Friday.")],
      },
    ],
    { authoritative: "them" },
  );
  assert.equal(lines.length, 1, "the duplicate must be dropped");
  assert.equal(lines[0]!.speaker, "Everyone else", "the wrong speaker must not survive");
});

test("two people agreeing at once is not bleed", () => {
  // Short overlapping utterances are genuinely simultaneous in meetings, and
  // deleting one would be inventing a silence.
  const lines = mergeTracks([
    { id: "me", label: "Me", segments: [me(5, 6, "Yeah, exactly.")] },
    { id: "them", label: "Everyone else", segments: [me(5.1, 6.2, "Yeah exactly!")] },
  ]);
  assert.equal(lines.length, 2);
});

test("similar things said at different times both survive", () => {
  // The same sentence twenty minutes apart is a repeated point, not an echo.
  const lines = mergeTracks([
    { id: "me", label: "Me", segments: [me(0, 4, "we should ship the migration first")] },
    { id: "them", label: "Everyone else", segments: [me(1200, 1204, "we should ship the migration first")] },
  ]);
  assert.equal(lines.length, 2);
});

test("a speaker's run becomes one quotable paragraph", () => {
  const lines = joinRuns(mergeTracks([
    {
      id: "them", label: "Dana",
      segments: [me(0, 3, "So the plan is."), me(3.1, 6, "We migrate in two stages."), me(6.2, 9, "Then we cut over.")],
    },
    { id: "me", label: "Me", segments: [me(30, 32, "Understood.")] },
  ]));
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.text, "So the plan is. We migrate in two stages. Then we cut over.");
  assert.equal(lines[0]!.end, 9, "the run must span to the end of its last segment");
  // A long gap breaks the run even for the same speaker.
  assert.equal(lines[1]!.speaker, "Me");
});

test("a run is broken by a long pause and by length", () => {
  const gapped = joinRuns([
    { at: 0, end: 3, speaker: "Me", trackId: "me", text: "First thought." },
    { at: 30, end: 33, speaker: "Me", trackId: "me", text: "Second thought." },
  ]);
  assert.equal(gapped.length, 2, "a thirty-second pause is not one paragraph");

  const long = joinRuns(
    [
      { at: 0, end: 3, speaker: "Me", trackId: "me", text: "a".repeat(500) },
      { at: 3.5, end: 6, speaker: "Me", trackId: "me", text: "b".repeat(500) },
    ],
    2,
    600,
  );
  assert.equal(long.length, 2, "a paragraph too long to point at is not one quote");
});

test("timecodes read as clock time", () => {
  assert.equal(timecode(0), "00:00:00");
  assert.equal(timecode(61), "00:01:01");
  assert.equal(timecode(3725), "01:02:05");
  assert.equal(timecode(-5), "00:00:00");
  assert.equal(timecode(9.9), "00:00:09");
});

const transcript: Line[] = [
  { at: 12, end: 18, speaker: "Dana", trackId: "them", text: "I'll send the revised deck over by Friday." },
  { at: 20, end: 25, speaker: "Me", trackId: "me", text: "Great — I'll review it on Monday morning." },
];

test("a quote is traced back to the line it came from", () => {
  const found = verifyQuote(transcript, "I'll send the revised deck over by Friday.");
  assert.ok(found);
  assert.equal(found.exact, true);
  assert.equal(found.line.speaker, "Dana");

  // Punctuation and casing differ constantly between a quote and its source.
  const loose = verifyQuote(transcript, "ill send the REVISED deck over by friday");
  assert.ok(loose?.exact, "punctuation must not decide whether a source is found");

  // A fragment of a line is still that line.
  assert.equal(verifyQuote(transcript, "revised deck over by Friday")?.line.speaker, "Dana");
});

test("a quote that was never said is reported as unverified", () => {
  // The failure this exists to catch: a plausible commitment nobody made. An
  // action item resting on it must never be shown as sourced.
  assert.equal(verifyQuote(transcript, "I'll have the budget approved by Wednesday."), undefined);
  assert.equal(verifyQuote(transcript, ""), undefined);
});

test("a near-miss is reported as inexact rather than as a match", () => {
  const near = verifyQuote(transcript, "I will review it on Monday morning");
  assert.ok(near, "a lightly reworded quote should still find its line");
  assert.equal(near.exact, false, "reworded is not verbatim, and must not claim to be");
  assert.equal(near.line.speaker, "Me");
});

test("similarity is containment, so a fragment scores high against its whole", () => {
  assert.equal(similarity("the migration", "we should ship the migration first"), 1);
  assert.equal(similarity("", "anything"), 0);
  assert.ok(similarity("completely unrelated words", "we should ship the migration") < 0.2);
});
