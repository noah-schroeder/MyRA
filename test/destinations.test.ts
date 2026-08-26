/**
 * The privacy claim, checked against the code that makes the requests.
 *
 * Settings renders "what leaves this machine" from `DESTINATIONS`. A list a
 * person maintains by hand is a list that goes stale the first time someone
 * adds a fetch and forgets, and a stale privacy claim is worse than no claim --
 * so this walks the source, pulls every URL literal out of it, and fails if a
 * host is reachable from the code but absent from the table.
 *
 * It reads string and template literals only. A hostname mentioned in a comment
 * (`169.254.169.254` appears in two of them, explaining an SSRF guard) is not a
 * request and must not be treated as one.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DESTINATIONS, describes, isLocalHost } from "../src/core/destinations.ts";

// fileURLToPath, not `.pathname`: this repository lives in a directory with a
// space in its name, and a raw pathname hands readdir a percent-encoded path.
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** `"https://api.github.com/…"` and `` `https://${x}` `` alike -- quote first. */
const URL_LITERAL = /["'`]https?:\/\/([A-Za-z0-9.-]+)/g;

/**
 * Comments out, before anything is matched.
 *
 * Doc comments here quote URLs in backticks (`http://host:1234`, the shape an
 * endpoint setting takes), which reads to the matcher above as a literal. The
 * line-comment pattern requires the `//` not to follow a colon, so the `//` in
 * `https://` inside a real string survives.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("every host the source can reach is declared", async () => {
  const undeclared = new Map<string, string>();

  for (const file of await sourceFiles(SRC)) {
    const text = stripComments(await readFile(file, "utf8"));
    for (const [, host] of text.matchAll(URL_LITERAL)) {
      if (!host || isLocalHost(host)) continue;
      if (describes(host)) continue;
      undeclared.set(host, file.slice(SRC.length));
    }
  }

  assert.deepEqual(
    [...undeclared],
    [],
    "add these to DESTINATIONS in src/core/destinations.ts, with what they send",
  );
});

test("suffix entries match the domain itself and its subdomains", () => {
  assert.ok(describes("cdn-lfs-us-1.hf.co"));
  assert.ok(describes("hf.co"));
  assert.ok(describes("objects.githubusercontent.com"));
  // Not a suffix match on a lookalike: `evilhf.co` must not pass.
  assert.equal(describes("evilhf.co"), undefined);
});

test("every destination says when it happens and what it sends", () => {
  for (const d of DESTINATIONS) {
    assert.ok(d.when.length > 10, `${d.host} needs a "when"`);
    assert.ok(d.sends.length > 3, `${d.host} needs a "sends"`);
  }
});
