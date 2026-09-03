/**
 * The image endpoint client.
 *
 * The parts worth testing are the ones a running Lemonade would only teach us
 * one reply at a time: the URL, what is on the wire, and every way a reply can
 * be wrong. The last group matters most -- the whole design rule of
 * core/images/generate.ts is that a surprising reply produces a sentence, never
 * a crash and never a zero-byte file on disk.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import {
  buildRequest, extensionFor, generate, ImageError, imagesUrl, sniffImage,
} from "../src/core/images/generate.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const endpoint = { baseUrl: "http://127.0.0.1:8000", envVar: "", model: "sd-turbo", timeoutMs: 120_000 };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answer one request with this body, and record what was asked. */
function reply(body: unknown, init: { status?: number; text?: string } = {}): { seen: () => RequestInit | undefined } {
  let seen: RequestInit | undefined;
  globalThis.fetch = (async (_url: string, opts: RequestInit) => {
    seen = opts;
    if (init.text !== undefined) {
      return new Response(init.text, { status: init.status ?? 200 });
    }
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { seen: () => seen };
}

describe("the endpoint URL", () => {
  it("appends /v1 when the base does not have it", () => {
    assert.equal(imagesUrl("http://127.0.0.1:8000"), "http://127.0.0.1:8000/v1/images/generations");
    assert.equal(imagesUrl("http://127.0.0.1:8000/"), "http://127.0.0.1:8000/v1/images/generations");
  });

  it("does not append a second one when the base already ends in a version", () => {
    /* A provider's base URL is typed by hand and half of them include /v1.
       Doubling it produces a 404 that reads like the model is missing. */
    assert.equal(imagesUrl("https://api.example.com/v1"), "https://api.example.com/v1/images/generations");
    assert.equal(imagesUrl("https://api.example.com/v2/"), "https://api.example.com/v2/images/generations");
  });
});

describe("what goes on the wire", () => {
  it("sends the model, the prompt and one image", () => {
    const body = buildRequest({ endpoint, prompt: "  a mitochondrion  " });
    assert.equal(body.model, "sd-turbo");
    assert.equal(body.prompt, "a mitochondrion");
    assert.equal(body.n, 1);
  });

  it("omits a negative prompt and a size entirely when they are not set", () => {
    /* Not sent as empty strings: an engine with an opinion about its own
       default should keep it, and `size: ""` is a 400 on some of them. */
    const body = buildRequest({ endpoint, prompt: "x" });
    assert.equal("negative_prompt" in body, false);
    assert.equal("size" in body, false);

    const blank = buildRequest({ endpoint, prompt: "x", negative: "   ", size: "  " });
    assert.equal("negative_prompt" in blank, false);
    assert.equal("size" in blank, false);
  });

  it("sends them when they are", () => {
    const body = buildRequest({ endpoint, prompt: "x", negative: "blurry", size: "768x768" });
    assert.equal(body.negative_prompt, "blurry");
    assert.equal(body.size, "768x768");
  });

  it("carries the API key as a bearer token", async () => {
    const call = reply({ data: [{ b64_json: PNG.toString("base64") }] });
    await generate({ endpoint, prompt: "x", apiKey: "sk-test" });
    const headers = call.seen()?.headers as Record<string, string>;
    assert.equal(headers["authorization"], "Bearer sk-test");
  });
});

describe("reading the reply", () => {
  it("decodes b64_json and names the type from the bytes", async () => {
    reply({ data: [{ b64_json: PNG.toString("base64") }] });
    const out = await generate({ endpoint, prompt: "x" });
    assert.equal(out.mime, "image/png");
    assert.deepEqual([...out.image], [...PNG]);
  });

  it("refuses a reply whose bytes are not an image", async () => {
    /* An error document served with a 200 is the common case here, and writing
       it to disk under a .png produces a file nobody can open and no
       explanation of why. */
    reply({ data: [{ b64_json: Buffer.from("<html>nope</html>").toString("base64") }] });
    await assert.rejects(generate({ endpoint, prompt: "x" }), (err: Error) => {
      assert.ok(err instanceof ImageError);
      assert.match(err.message, /not an image/);
      return true;
    });
  });

  it("refuses an empty image rather than saving nothing", async () => {
    reply({ data: [{ b64_json: "" }] });
    await assert.rejects(generate({ endpoint, prompt: "x" }), /neither image data nor a usable URL/);
  });

  it("says so when there is no data at all", async () => {
    reply({ data: [] });
    await assert.rejects(generate({ endpoint, prompt: "x" }), /returned no image/);
  });

  it("repeats the endpoint's own refusal when it gave one", async () => {
    reply({ error: { message: "model is not loaded" } });
    await assert.rejects(generate({ endpoint, prompt: "x" }), /model is not loaded/);
  });

  it("will not follow a file: URL", async () => {
    /* An endpoint that returns a path instead of bytes would otherwise turn an
       image generator into an arbitrary file read on the user's machine. */
    reply({ data: [{ url: "file:///etc/passwd" }] });
    await assert.rejects(generate({ endpoint, prompt: "x" }), /neither image data nor a usable URL/);
  });

  it("refuses a body that is not JSON", async () => {
    reply(undefined, { text: "<html>gateway error</html>" });
    await assert.rejects(generate({ endpoint, prompt: "x" }), /not JSON/);
  });
});

describe("failures that need their own sentence", () => {
  it("names a rejected key", async () => {
    reply(undefined, { status: 401, text: "no" });
    await assert.rejects(generate({ endpoint, prompt: "x" }), /rejected the API key \(401\)/);
  });

  it("names the URL it tried on a 404, because that is the setting to fix", async () => {
    reply(undefined, { status: 404, text: "no" });
    await assert.rejects(generate({ endpoint, prompt: "x" }), /127\.0\.0\.1:8000\/v1\/images\/generations/);
  });

  it("carries the server's words on a 500", async () => {
    reply(undefined, { status: 500, text: "CUDA out of memory" });
    await assert.rejects(generate({ endpoint, prompt: "x" }), /CUDA out of memory/);
  });

  it("asks for a model before it asks for anything else", async () => {
    await assert.rejects(
      generate({ endpoint: { ...endpoint, model: "" }, prompt: "x" }),
      /No image model is set up/,
    );
  });

  it("does not post an empty prompt", async () => {
    await assert.rejects(generate({ endpoint, prompt: "   " }), /nothing to draw/);
  });

  it("distinguishes a user stopping it from a timeout", async () => {
    const control = new AbortController();
    globalThis.fetch = (async () => {
      control.abort();
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;
    await assert.rejects(
      generate({ endpoint, prompt: "x", signal: control.signal }),
      /Stopped before the image was finished/,
    );
  });
});

describe("naming the file", () => {
  it("sniffs the formats these engines actually return", () => {
    assert.equal(sniffImage(PNG), "image/png");
    assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.equal(sniffImage(Buffer.from("RIFF____WEBPVP8 ", "latin1")), "image/webp");
    assert.equal(sniffImage(Buffer.from([1, 2, 3, 4])), undefined);
    assert.equal(sniffImage(Buffer.from([])), undefined);
  });

  it("gives the file an extension that opens by double-clicking it", () => {
    assert.equal(extensionFor("image/png"), "png");
    assert.equal(extensionFor("image/jpeg"), "jpg");
    assert.equal(extensionFor("image/webp"), "webp");
    assert.equal(extensionFor("application/octet-stream"), "png");
  });
});
