/**
 * The two content security policies, checked against each other.
 *
 * The window is under both: a meta tag in index.html and a header the main
 * process attaches in `onHeadersReceived`. A page under two policies gets the
 * INTERSECTION of them, so the stricter one silently wins every disagreement
 * -- and a directive that is simply missing from one is not "unset", it falls
 * back to that policy's `default-src`.
 *
 * That is not a hypothetical. `media-src` was absent from the meta tag while
 * the header allowed `blob:`, so media fell back to `default-src 'self'`, and
 * every spoken reply failed with
 *
 *     MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check
 *     Refused to load media from 'blob:…' (media-src)
 *
 * which the UI reported as "That audio could not be played: the voice model
 * returned audio/wav". It reads as a broken audio file, so it was twice
 * diagnosed as one -- the container was rebuilt, correctly, and the audio
 * still would not play, because nothing about the container was ever the
 * problem.
 *
 * This walks both policies and fails when one allows a source the other does
 * not, which is the shape of that bug rather than one instance of it.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const read = async (rel: string): Promise<string> =>
  readFile(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");

type Policy = Map<string, Set<string>>;

function parsePolicy(text: string): Policy {
  const out: Policy = new Map();
  for (const clause of text.split(";")) {
    const [name, ...sources] = clause.trim().split(/\s+/);
    if (name) out.set(name, new Set(sources));
  }
  return out;
}

/** What a directive resolves to, following the fallback the browser follows. */
function effective(policy: Policy, directive: string): Set<string> {
  return policy.get(directive) ?? policy.get("default-src") ?? new Set();
}

async function metaPolicy(): Promise<Policy> {
  const html = await read("renderer/index.html");
  const found = /http-equiv="Content-Security-Policy"\s*\n?\s*content="([^"]+)"/.exec(html);
  assert.ok(found?.[1], "index.html must carry a Content-Security-Policy meta tag");
  return parsePolicy(found[1]);
}

/**
 * The packaged policy from main, read out of the source.
 *
 * The dev-server branch beside it is deliberately not checked: it exists to
 * let Vite work and is never what a user runs.
 */
async function headerPolicy(): Promise<Policy> {
  const source = await read("main/index.ts");
  const found = /:\s*"(default-src 'self'; script-src 'self';[\s\S]*?)";/.exec(source);
  assert.ok(found?.[1], "main/index.ts must build a packaged CSP string");
  return parsePolicy(found[1].replace(/"\s*\+\s*\n?\s*"/g, ""));
}

/* The directives that decide whether the app's own features work at all. */
const SHARED = ["default-src", "script-src", "style-src", "img-src", "media-src", "connect-src"];

test("neither policy allows a source the other forbids", async () => {
  const meta = await metaPolicy();
  const header = await headerPolicy();
  for (const directive of SHARED) {
    const a = [...effective(meta, directive)].sort();
    const b = [...effective(header, directive)].sort();
    assert.deepEqual(
      a, b,
      `${directive} differs: index.html has [${a.join(" ")}], main/index.ts has [${b.join(" ")}]. ` +
      "The browser enforces both, so the stricter one wins and the looser one is a lie.",
    );
  }
});

test("audio Karen synthesised on this machine can be played", async () => {
  // The renderer wraps voice audio in a Blob it made itself, from bytes that
  // arrived over IPC. Nothing about it touches the network, and without this
  // the speech feature cannot work at all.
  for (const [where, policy] of [["index.html", await metaPolicy()], ["main", await headerPolicy()]] as const) {
    assert.ok(
      effective(policy, "media-src").has("blob:"),
      `${where} does not allow blob: media, so spoken replies cannot be played`,
    );
  }
});

test("the policies still forbid what they are there to forbid", async () => {
  // The fix above widens one directive. This is the line it must not cross.
  for (const [where, policy] of [["index.html", await metaPolicy()], ["main", await headerPolicy()]] as const) {
    assert.deepEqual([...effective(policy, "connect-src")], ["'self'"], `${where} connect-src`);
    assert.deepEqual([...effective(policy, "script-src")], ["'self'"], `${where} script-src`);
    assert.deepEqual([...(policy.get("object-src") ?? [])], ["'none'"], `${where} object-src`);
    for (const directive of SHARED) {
      for (const source of effective(policy, directive)) {
        assert.ok(
          !/^https?:/.test(source),
          `${where} ${directive} names a remote origin (${source})`,
        );
      }
    }
  }
});
