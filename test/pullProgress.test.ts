/**
 * Reading the daemon's download progress.
 *
 * `/pull` with `stream: true` answers `text/event-stream`. The parsing is
 * worth pinning down because a chunk boundary can fall anywhere -- including
 * mid-number -- and because a progress bar must never be the thing that fails
 * a download.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { readProgressStream } from "../src/main/runtime/lemonadeApi.ts";
import type { PullProgress } from "../src/core/runtime/systemInfo.ts";

/** A stream that hands over exactly the chunks given, as the network would. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) return controller.close();
      controller.enqueue(encoder.encode(chunks[i++]!));
    },
  });
}

const frame = (data: Record<string, unknown>): string =>
  `event: progress\ndata: ${JSON.stringify(data)}\n\n`;

/* Shaped exactly as the daemon sends it, copied from a real pull. */
const REAL = {
  bytes_downloaded: 0,
  bytes_previously_downloaded: 0,
  bytes_total: 77691713,
  file: "ggml-tiny.bin",
  file_index: 1,
  percent: 0,
  total_download_size: 77691713,
  total_files: 1,
};

async function collect(chunks: string[]): Promise<PullProgress[]> {
  const out: PullProgress[] = [];
  await readProgressStream(streamOf(chunks), (p) => out.push(p));
  return out;
}

test("a progress frame becomes the figures the bar needs", async () => {
  const [p] = await collect([frame({ ...REAL, bytes_downloaded: 38845856, percent: 50 })]);
  assert.equal(p!.file, "ggml-tiny.bin");
  assert.equal(p!.bytesDone, 38845856);
  assert.equal(p!.bytesTotal, 77691713);
  assert.equal(p!.percent, 50);
  assert.equal(p!.totalFiles, 1);
});

test("a frame split across chunks is still read once, and correctly", async () => {
  // The case that breaks a naive per-chunk parser: the boundary lands inside
  // the number.
  const whole = frame({ ...REAL, bytes_downloaded: 12345678, percent: 15 });
  const cut = whole.indexOf("12345678") + 4;
  const got = await collect([whole.slice(0, cut), whole.slice(cut)]);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.bytesDone, 12345678);
});

test("several frames in one chunk all arrive", async () => {
  const got = await collect([
    frame({ ...REAL, percent: 10 }) + frame({ ...REAL, percent: 20 }) + frame({ ...REAL, percent: 30 }),
  ]);
  assert.deepEqual(got.map((p) => p.percent), [10, 20, 30]);
});

test("bytes already on disk count towards what is done", async () => {
  // A resumed download reports the earlier bytes separately; leaving them out
  // makes a half-finished transfer look like it restarted.
  const [p] = await collect([
    frame({ ...REAL, bytes_downloaded: 1_000_000, bytes_previously_downloaded: 4_000_000 }),
  ]);
  assert.equal(p!.bytesDone, 5_000_000);
});

test("the whole-transfer size is preferred, because bytes_total drops to zero", async () => {
  /* Measured: only the first frame carries a real `bytes_total`; every later
     one sends 0, and a bar that divides by it would jump to nothing. */
  const [p] = await collect([
    frame({ ...REAL, bytes_total: 0, bytes_downloaded: 500, total_download_size: 77691713 }),
  ]);
  assert.equal(p!.bytesTotal, 77691713);
});

test("a multi-file pull says which file it is on", async () => {
  const [p] = await collect([
    frame({ ...REAL, file: "part2.gguf", file_index: 2, total_files: 3 }),
  ]);
  assert.equal(p!.fileIndex, 2);
  assert.equal(p!.totalFiles, 3);
});

test("an unparseable frame is skipped rather than failing the download", async () => {
  const got = await collect([
    "event: progress\ndata: {not json\n\n" + frame({ ...REAL, percent: 42 }),
  ]);
  assert.deepEqual(got.map((p) => p.percent), [42]);
});

test("a trailing partial frame is dropped rather than half-read", async () => {
  const got = await collect([frame({ ...REAL, percent: 5 }) + "event: progress\ndata: {\"per"]);
  assert.equal(got.length, 1);
});

test("frames with no data line are ignored", async () => {
  assert.deepEqual(await collect([": keep-alive\n\n", "event: done\n\n"]), []);
});
