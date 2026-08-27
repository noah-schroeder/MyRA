/**
 * Reading a response without trusting how big it is.
 *
 * The URL behind these bytes is chosen by a model acting on text written by
 * strangers, so "the server said content-length: 500" is a claim, not a fact.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { readCapped, TooLarge } from "../src/core/research/fetch.ts";

/** A Response whose body streams `chunks` and declares whatever we tell it to. */
function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, { headers });
}

const bytes = (n: number, fill = 65): Uint8Array => new Uint8Array(n).fill(fill);

describe("readCapped", () => {
  it("returns a body that fits, whole", async () => {
    const out = await readCapped(streamed([bytes(10), bytes(10)]), 100);
    assert.equal(out.byteLength, 20);
    assert.equal(new TextDecoder().decode(out.slice(0, 3)), "AAA");
  });

  it("returns a body exactly at the limit", async () => {
    const out = await readCapped(streamed([bytes(50), bytes(50)]), 100);
    assert.equal(out.byteLength, 100);
  });

  it("refuses one byte over, rather than buffering it first", async () => {
    await assert.rejects(() => readCapped(streamed([bytes(101)]), 100), TooLarge);
  });

  it("stops mid-stream instead of reading to the end", async () => {
    /*
     * The point of the whole function. A body that never ends must not be read
     * until the process dies -- so the reader has to give up partway, and this
     * counts how far it got. `pulled` would keep climbing forever if the cap
     * were applied after the read rather than during it.
     */
    let pulled = 0;
    const endless = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          if (pulled > 10_000) throw new Error("readCapped never stopped");
          controller.enqueue(bytes(1024));
        },
      }),
    );
    await assert.rejects(() => readCapped(endless, 4096), TooLarge);
    assert.ok(pulled <= 10, `gave up after ${pulled} chunks`);
  });

  it("ignores a content-length that lies about being small", async () => {
    const res = streamed([bytes(5000)], { "content-length": "10" });
    await assert.rejects(() => readCapped(res, 1000), TooLarge);
  });

  it("handles a response with no body at all", async () => {
    const out = await readCapped(new Response(null, { status: 204 }), 100);
    assert.equal(out.byteLength, 0);
  });
});
