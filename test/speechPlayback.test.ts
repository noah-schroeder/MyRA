/**
 * Releasing the audio element must not look like the audio failing.
 *
 * Reported as "That audio could not be played: the voice model returned
 * audio/wav" appearing *after* a reply had been read out perfectly well --
 * intermittently, because whether it showed depended on whether the next turn
 * had already bumped the generation counter when the stray event landed.
 *
 * `src = ""` is the cause. An empty string is not "no source": it resolves
 * against the page, so the element loads the HTML document as media. Measured
 * under this app's own Electron:
 *
 *     with `a.src = ""`                    ended | error:4
 *     with `removeAttribute` + `load()`    ended
 *
 * Code 4 is MEDIA_ERR_SRC_NOT_SUPPORTED, and `useSpeech`'s `onerror` was still
 * attached to hear it.
 *
 * There is no DOM in the test runner, so this reads the source and pins the
 * two properties that keep a released element silent: nothing assigns `src`,
 * and the handlers come off before the element is torn down.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = await readFile(
  fileURLToPath(new URL("../src/renderer/useSpeech.ts", import.meta.url)),
  "utf8",
);

/** The body of `release`, from its arrow to the closing brace of the callback. */
function releaseBody(text: string): string {
  const start = text.indexOf("const release = useCallback");
  assert.notEqual(start, -1, "useSpeech no longer has a release callback");
  const end = text.indexOf("\n  }, []);", start);
  assert.notEqual(end, -1, "could not find the end of release");
  return text.slice(start, end);
}

describe("releasing a spoken reply", () => {
  it("never assigns to src", () => {
    /* Comments describe the failure, so they are stripped before looking. */
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    assert.equal(
      /\.src\s*=/.test(code),
      false,
      "assigning src loads the page as media and fires error",
    );
  });

  it("detaches the handlers before tearing the element down", () => {
    const body = releaseBody(source);
    for (const handler of ["onended", "onerror"]) {
      const off = body.indexOf(`${handler} = null`);
      assert.notEqual(off, -1, `release does not detach ${handler}`);
      assert.ok(off < body.indexOf(".load()"), `${handler} is detached too late`);
    }
  });

  it("ends the resource rather than pointing it at nothing", () => {
    const body = releaseBody(source);
    assert.match(body, /removeAttribute\("src"\)/);
    assert.match(body, /\.load\(\)/);
  });

  it("does not blame the voice model for an interrupted play()", () => {
    /* Barge-in and switching the mode off both reject play() with AbortError.
       The element is no longer the current one by then, and that is the test:
       an interruption the user performed is not a fault to report. */
    assert.match(source, /audio\.current === element \? cannotPlay : undefined/);
  });
});
