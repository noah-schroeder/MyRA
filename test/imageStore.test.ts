/**
 * Generated images on disk.
 *
 * Two rules are being defended. A prompt becomes a filename, so it is user text
 * joined onto a path; and the sidecar is the done-marker, so a listing shows
 * finished generations and nothing else.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  assertImageId, byNewest, idOfSidecar, imageId, parseRecord, sidecarName,
} from "../src/core/images/store.ts";

describe("naming a file after a prompt", () => {
  /* Local, not UTC: this name is read beside the file manager's own clock, and
     a Date built from parts is the only way to say "14:35 where the user is"
     without the test depending on the machine's timezone. */
  const when = new Date(2026, 8, 3, 14, 35, 0);

  it("is a date, a time and a slug", () => {
    assert.equal(imageId("a mitochondrion", when), "20260903-1435-a-mitochondrion");
  });

  it("keeps only the first few words, so the name stays a name", () => {
    const id = imageId("one two three four five six seven eight", when);
    assert.equal(id, "20260903-1435-one-two-three-four-five-six");
  });

  it("survives a prompt with nothing usable in it", () => {
    assert.equal(imageId("!!! ???", when), "20260903-1435-image");
    assert.equal(imageId("", when), "20260903-1435-image");
  });

  it("takes the path out of a prompt that is trying to be one", () => {
    /* The whole reason this is a slug and not the prompt: everything outside
       [a-z0-9] becomes a hyphen, so there is no separator left to traverse
       with and no leading dot to hide behind. */
    for (const nasty of ["../../etc/passwd", "..", ".", "/etc/shadow", "a\\b", "C:\\x"]) {
      const id = imageId(nasty, when);
      assert.doesNotThrow(() => assertImageId(id), nasty);
      assert.equal(/[/\\]/.test(id), false, nasty);
    }
  });

  it("caps the length, because a filesystem does too", () => {
    const id = imageId("supercalifragilistic ".repeat(20), when);
    assert.ok(id.length <= 90, String(id.length));
  });

  it("uses the clock the user is on, not UTC", () => {
    /* Half past midnight locally. Formatted through toISOString this lands on
       the previous day anywhere west of Greenwich and at a different hour
       nearly everywhere -- which is what put "1710" on a picture the file
       manager beside it said was made at 10:10. */
    assert.equal(imageId("a cell", new Date(2026, 0, 1, 0, 30)), "20260101-0030-a-cell");
  });

  it("takes a salt, so two images made in the same minute do not collide", () => {
    assert.notEqual(imageId("a cell", when, "1f2e"), imageId("a cell", when, "9a0b"));
  });
});

describe("ids that come back from the window", () => {
  it("accepts one it made", () => {
    const id = imageId("a cell");
    assert.equal(assertImageId(id), id);
  });

  it("refuses anything that could leave the images folder", () => {
    for (const bad of ["..", ".", "../x", "a/b", "a\\b", "", "a b", "x\0y"]) {
      assert.throws(() => assertImageId(bad), /no image named/, bad);
    }
  });

  it("names the sidecar after the image, and reads the id back out", () => {
    assert.equal(sidecarName("20260903-1435-a-cell"), "20260903-1435-a-cell.json");
    assert.equal(idOfSidecar("20260903-1435-a-cell.json"), "20260903-1435-a-cell");
  });

  it("does not mistake the image itself for a done-marker", () => {
    /* The listing enumerates sidecars. An interrupted generation leaves the
       .png behind, and it must not appear as a finished image. */
    assert.equal(idOfSidecar("20260903-1435-a-cell.png"), undefined);
    assert.equal(idOfSidecar("notes.txt"), undefined);
    assert.equal(idOfSidecar("../escape.json"), undefined);
  });
});

describe("reading a record back", () => {
  const good = {
    prompt: "a cell", sentPrompt: "a cell, flat vector",
    negative: "blurry", sentNegative: "blurry, text, letters",
    size: "512x512", model: "sd-turbo", preset: "conceptual", external: false,
    at: "2026-09-03T14:35:00.000Z", file: "20260903-1435-a-cell.png",
    mime: "image/png", bytes: 1234, seconds: 8.5,
  };

  it("round-trips one it wrote", () => {
    const record = parseRecord(good, "20260903-1435-a-cell");
    assert.equal(record?.prompt, "a cell");
    assert.equal(record?.preset, "conceptual");
    assert.equal(record?.seconds, 8.5);
    assert.equal(record?.id, "20260903-1435-a-cell");
  });

  it("skips a file rather than throwing on it", () => {
    /* This folder is one the user is invited to open, so one of these will
       eventually be edited by hand or truncated by a full disk. A gallery that
       throws on the fifth of two hundred images is worse than one that skips
       it. */
    assert.equal(parseRecord(undefined, "x"), undefined);
    assert.equal(parseRecord("not an object", "x"), undefined);
    assert.equal(parseRecord([], "x"), undefined);
    assert.equal(parseRecord({ ...good, file: "" }, "x"), undefined);
    assert.equal(parseRecord({ ...good, file: "../../etc/passwd" }, "x"), undefined);
  });

  it("fills in what a hand-edited file left out", () => {
    const record = parseRecord({ file: "a.png" }, "a");
    assert.equal(record?.mime, "image/png");
    assert.equal(record?.bytes, 0);
    assert.equal(record?.external, false);
    assert.equal("preset" in (record ?? {}), false);
  });

  it("treats a missing sentPrompt as the prompt, for images made before presets", () => {
    const record = parseRecord({ file: "a.png", prompt: "a cell" }, "a");
    assert.equal(record?.sentPrompt, "a cell");
  });

  it("keeps the typed and the sent negative apart", () => {
    /* What was typed is what goes back in the box on "use this prompt again";
       what was sent is the record of how the picture was actually made. Reusing
       the sent one would fold the preset's avoid terms in again every time. */
    const record = parseRecord(good, "a");
    assert.equal(record?.negative, "blurry");
    assert.equal(record?.sentNegative, "blurry, text, letters");

    const old = parseRecord({ file: "a.png", negative: "blurry" }, "a");
    assert.equal(old?.sentNegative, "blurry");
  });

  it("only believes external when it is exactly true", () => {
    assert.equal(parseRecord({ file: "a.png", external: "yes" }, "a")?.external, false);
    assert.equal(parseRecord({ file: "a.png", external: true }, "a")?.external, true);
  });
});

describe("the order a gallery reads in", () => {
  it("is newest first", () => {
    const at = (s: string, id: string) => parseRecord({ file: "a.png", at: s }, id)!;
    const list = [at("2026-09-01T00:00:00Z", "a"), at("2026-09-03T00:00:00Z", "c"), at("2026-09-02T00:00:00Z", "b")];
    assert.deepEqual([...list].sort(byNewest).map((r) => r.id), ["c", "b", "a"]);
  });
});
