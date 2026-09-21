/**
 * Reading a GGUF's shape off the file itself.
 *
 * `core/runtime/gguf.ts` does the parsing and cannot touch a disk -- `src/core/`
 * must never import `electron`, and a module that does cannot be loaded by the
 * test runner at all. This is the other half, the way `zoteroDb.ts`/
 * `zoteroSqlite.ts` and `strays.ts`/`daemons.ts` split the same way: the SQL or
 * the decision lives in `core/`, the disk touches main.
 */

import { open } from "node:fs/promises";

import { modelShape, parseGguf } from "../../core/runtime/gguf.ts";
import type { ModelShape } from "../../core/runtime/fit.ts";

/**
 * Read as much of a model's GGUF header as this many bytes hold.
 *
 * 8 MiB rather than the 4 an earlier version of this used: measured against
 * two real files, an LFM2.5-2.6B needed 7.84 MiB for a complete parse and a
 * SmolLM2-135M needed 1.69. **Never grown on truncation.** `general.*` and
 * `<arch>.*` are written before the tokenizer vocabulary, so a truncated parse
 * still yields a complete shape -- the only field a small read can miss is
 * `hasChatTemplate`, reported as `undefined` rather than guessed, and nothing
 * in the app reads it today. Spending a second, larger read to learn a field
 * with no consumer is the wrong trade, so a truncated result is returned as is
 * rather than retried.
 */
export async function readShapeFromFile(
  path: string,
  bytes = 8 * 1024 * 1024,
): Promise<ModelShape | undefined> {
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    if (!bytesRead) return undefined;
    return modelShape(parseGguf(buf.subarray(0, bytesRead)));
  } finally {
    await handle.close();
  }
}
