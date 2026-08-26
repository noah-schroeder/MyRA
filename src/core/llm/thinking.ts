/**
 * Separating a model's reasoning from its answer, as it arrives.
 *
 * There are two conventions and a local server will use either. llama.cpp with
 * `--jinja` normally extracts the thinking into `reasoning_content`, a field
 * beside `content`; some templates emit it inline, wrapped in `<think>` tags,
 * and leave the caller to deal with it. Both have to work, because which one
 * you get depends on the model file rather than on anything the app chose.
 *
 * Inline is the harder case: the tag arrives split across frames often enough
 * that a naive `indexOf` on each delta will miss it, and passing `<` through to
 * the transcript while waiting for the rest of a tag makes the answer flicker.
 * So text is held back only as far as it could still be part of a tag -- at
 * most eight characters -- and released the moment it cannot be.
 *
 * Reasoning is kept out of the message that goes back to the model. It is the
 * model's own workings on a question it has already answered; replaying it
 * wastes context, and several model families are explicit that it should not be
 * fed back.
 */

export type DeltaKind = "text" | "thinking";

const OPEN = "<think>";
const CLOSE = "</think>";

/** The longest suffix of `s` that could still become the start of `tag`. */
function heldBack(s: string, tag: string): number {
  const most = Math.min(s.length, tag.length - 1);
  for (let n = most; n > 0; n--) {
    if (tag.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}

export interface ThinkingSplitter {
  push(delta: string): void;
  /** Releases whatever was held back waiting for a tag that never came. */
  flush(): void;
}

export function splitThinking(emit: (text: string, kind: DeltaKind) => void): ThinkingSplitter {
  let buffer = "";
  let inside = false;

  const release = (upTo: number): void => {
    if (upTo <= 0) return;
    emit(buffer.slice(0, upTo), inside ? "thinking" : "text");
    buffer = buffer.slice(upTo);
  };

  return {
    push(delta: string): void {
      buffer += delta;
      for (;;) {
        const tag = inside ? CLOSE : OPEN;
        const at = buffer.indexOf(tag);
        if (at !== -1) {
          release(at);
          buffer = buffer.slice(tag.length);
          inside = !inside;
          continue;
        }
        release(buffer.length - heldBack(buffer, tag));
        return;
      }
    },
    flush(): void {
      release(buffer.length);
    },
  };
}
