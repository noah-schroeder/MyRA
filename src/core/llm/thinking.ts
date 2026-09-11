/**
 * Separating a model's reasoning from its answer, as it arrives.
 *
 * There are two conventions and a server will use either. llama.cpp with
 * `--jinja` normally extracts the thinking into `reasoning_content`, a field
 * beside `content`; some templates emit it inline, wrapped in tags, and leave
 * the caller to deal with it. Both have to work, because which one you get
 * depends on the model file rather than on anything the app chose.
 *
 * Two inline spellings, because two families are in wide use: `<think>` is what
 * Qwen, DeepSeek's distills and most llama.cpp templates emit, and `<thinking>`
 * is what the Claude family writes and what several hosted gateways pass
 * through unchanged. MyRA knew only the first, so against a provider using the
 * second the whole chain of reasoning was printed into the answer as prose --
 * present, but not marked as reasoning and not foldable away.
 *
 * Inline is the harder case: the tag arrives split across frames often enough
 * that a naive `indexOf` on each delta will miss it, and passing `<` through to
 * the transcript while waiting for the rest of a tag makes the answer flicker.
 * So text is held back only as far as it could still be part of a tag -- at
 * most eleven characters now that `</thinking>` is one of them -- and released
 * the moment it cannot be.
 *
 * Reasoning is kept out of the message that goes back to the model. It is the
 * model's own workings on a question it has already answered; replaying it
 * wastes context, and several model families are explicit that it should not be
 * fed back.
 */

export type DeltaKind = "text" | "thinking";

/**
 * Open/close pairs, longest spelling first.
 *
 * No prefix hazard between them: `<think>` and `<thinking>` differ at the
 * seventh character, so neither can match where the other was meant. The order
 * matters only for the held-back calculation below, which takes the longest.
 */
const PAIRS: readonly (readonly [string, string])[] = [
  ["<thinking>", "</thinking>"],
  ["<think>", "</think>"],
];

/** The longest suffix of `s` that could still become the start of `tag`. */
function heldBack(s: string, tag: string): number {
  const most = Math.min(s.length, tag.length - 1);
  for (let n = most; n > 0; n--) {
    if (tag.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}

/** How much to keep buffered for the several tags that could still arrive. */
function heldBackAny(s: string, tags: readonly string[]): number {
  let most = 0;
  for (const tag of tags) most = Math.max(most, heldBack(s, tag));
  return most;
}

export interface ThinkingSplitter {
  push(delta: string): void;
  /** Releases whatever was held back waiting for a tag that never came. */
  flush(): void;
}

export function splitThinking(emit: (text: string, kind: DeltaKind) => void): ThinkingSplitter {
  let buffer = "";
  /* Which pair opened the current block, so the close tag is the matching one:
     a `<think>` block is not ended by `</thinking>`. */
  let inside: (typeof PAIRS)[number] | undefined;

  const release = (upTo: number): void => {
    if (upTo <= 0) return;
    emit(buffer.slice(0, upTo), inside ? "thinking" : "text");
    buffer = buffer.slice(upTo);
  };

  return {
    push(delta: string): void {
      buffer += delta;
      for (;;) {
        if (inside) {
          const close = inside[1];
          const at = buffer.indexOf(close);
          if (at !== -1) {
            release(at);
            buffer = buffer.slice(close.length);
            inside = undefined;
            continue;
          }
          release(buffer.length - heldBack(buffer, close));
          return;
        }

        /* Outside: whichever opener appears first wins, and nothing is released
           past the point where an opener could still be forming. */
        let first = -1;
        let opened: (typeof PAIRS)[number] | undefined;
        for (const pair of PAIRS) {
          const at = buffer.indexOf(pair[0]);
          if (at !== -1 && (first === -1 || at < first)) {
            first = at;
            opened = pair;
          }
        }
        if (opened) {
          release(first);
          buffer = buffer.slice(opened[0].length);
          inside = opened;
          continue;
        }
        release(buffer.length - heldBackAny(buffer, PAIRS.map((p) => p[0])));
        return;
      }
    },
    flush(): void {
      release(buffer.length);
    },
  };
}
