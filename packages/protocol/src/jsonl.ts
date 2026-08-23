/**
 * Byte-level JSONL framing.
 *
 * pi's RPC protocol is strict JSONL delimited by LF (0x0A) and ONLY by LF.
 * Its documentation explicitly warns that generic line readers which also treat
 * Unicode separators as line breaks violate the protocol -- Node's `readline`
 * splits on \n, \r, U+2028 and U+2029, so using it here silently corrupts any
 * payload containing those characters (which model output frequently does).
 *
 * We therefore split on the raw byte 0x0A over Buffers, and only decode UTF-8
 * once a complete line has been isolated. Splitting on bytes before decoding
 * also makes multi-byte characters straddling a chunk boundary a non-issue.
 *
 * NEVER replace this with readline, string.split(/\r?\n/), or similar.
 */

const LF = 0x0a;
const CR = 0x0d;
const EMPTY = Buffer.alloc(0);

/** Default cap on a single line, to bound memory against a runaway peer. */
export const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;

export class ProtocolError extends Error {
  override readonly name = "ProtocolError";
}

export interface JsonlSplitterOptions {
  /** Reject (rather than buffer forever) a line exceeding this many bytes. */
  maxLineBytes?: number;
}

/**
 * Incremental LF-delimited line splitter.
 *
 * Feed it raw chunks; it returns whole lines as UTF-8 strings. Blank lines are
 * skipped, since JSONL permits them as padding and they carry no frame.
 */
export class JsonlSplitter {
  #buf: Buffer = EMPTY;
  /** Bytes of #buf already known to contain no LF, so we never rescan them. */
  #scanned = 0;
  readonly #maxLineBytes: number;

  constructor(options: JsonlSplitterOptions = {}) {
    this.#maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  }

  /** Number of bytes currently held in the incomplete-line buffer. */
  get buffered(): number {
    return this.#buf.length;
  }

  push(chunk: Buffer | Uint8Array): string[] {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#buf = this.#buf.length === 0 ? incoming : Buffer.concat([this.#buf, incoming]);

    const lines: string[] = [];
    let start = 0;

    for (;;) {
      const from = Math.max(start, this.#scanned);
      const idx = this.#buf.indexOf(LF, from);
      if (idx === -1) break;
      lines.push(decodeLine(this.#buf.subarray(start, idx)));
      start = idx + 1;
    }

    this.#buf = start === 0 ? this.#buf : this.#buf.subarray(start);
    // Everything still buffered has been searched and provably contains no LF.
    this.#scanned = this.#buf.length;

    if (this.#buf.length > this.#maxLineBytes) {
      throw new ProtocolError(
        `JSONL line exceeded ${this.#maxLineBytes} bytes without a newline; ` +
          `peer is not speaking the protocol`,
      );
    }

    return lines.filter((l) => l.length > 0);
  }

  /**
   * Return any trailing bytes not terminated by a newline. Call at stream end;
   * a well-behaved peer leaves nothing behind.
   */
  flush(): string | undefined {
    if (this.#buf.length === 0) return undefined;
    const line = decodeLine(this.#buf);
    this.#buf = EMPTY;
    this.#scanned = 0;
    return line.length > 0 ? line : undefined;
  }

  reset(): void {
    this.#buf = EMPTY;
    this.#scanned = 0;
  }
}

/**
 * Decode one line's bytes to a string.
 *
 * A trailing CR is stripped defensively in case a peer emits CRLF. This is safe
 * for JSON: a raw 0x0D byte cannot occur inside a JSON string (it must be
 * escaped as \r), so a trailing CR is never significant payload.
 */
function decodeLine(bytes: Buffer): string {
  const end = bytes.length > 0 && bytes[bytes.length - 1] === CR ? bytes.length - 1 : bytes.length;
  return bytes.toString("utf8", 0, end);
}

/**
 * Serialise a value as one JSONL record, newline included.
 *
 * JSON.stringify escapes literal newlines inside strings, so the result is
 * guaranteed to contain exactly one LF: the terminator.
 */
export function encodeJsonl(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new ProtocolError("value is not JSON-serialisable");
  }
  return json + "\n";
}

export interface ParsedLine<T> {
  ok: boolean;
  value?: T;
  error?: Error;
  raw: string;
}

/**
 * Parse a line without throwing, so one malformed frame cannot kill the stream.
 */
export function parseJsonlLine<T = unknown>(line: string): ParsedLine<T> {
  try {
    return { ok: true, value: JSON.parse(line) as T, raw: line };
  } catch (cause) {
    return {
      ok: false,
      error: new ProtocolError(`malformed JSONL frame: ${(cause as Error).message}`),
      raw: line,
    };
  }
}
