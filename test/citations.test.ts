import { test } from "node:test";
import assert from "node:assert/strict";
import { markerNumbers } from "../src/renderer/components/citeMarkers.ts";

test("ordinary citation forms are recognised", () => {
  assert.deepEqual(markerNumbers("1"), [1]);
  assert.deepEqual(markerNumbers("2, 5"), [2, 5]);
  assert.deepEqual(markerNumbers("7-9"), [7, 8, 9]);
  assert.deepEqual(markerNumbers("7–9"), [7, 8, 9], "en dash, as prose actually writes it");
  assert.deepEqual(markerNumbers("1, 3-5"), [1, 3, 4, 5]);
});

test("a year span in prose is not thirty-one citations", () => {
  // "[1990-2020]" appears in ordinary writing. Reading it as a range would
  // invent references and, worse, render them as links to nothing.
  assert.deepEqual(markerNumbers("1990-2020"), []);
  assert.deepEqual(markerNumbers("2019"), []);
});

test("a reversed or oversized range is not a citation", () => {
  assert.deepEqual(markerNumbers("9-7"), []);
  assert.deepEqual(markerNumbers("1-500"), []);
});

test("non-numeric bracket contents are left alone", () => {
  assert.deepEqual(markerNumbers("sic"), []);
  assert.deepEqual(markerNumbers("0"), [], "there is no source zero");
  assert.deepEqual(markerNumbers(""), []);
});
