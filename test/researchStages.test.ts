/**
 * The run as a sequence somebody can watch.
 *
 * Progress was one line above the composer, replaced several times a second:
 * it said what was happening and nothing about where that sat in a process
 * that takes minutes, so a stage that legitimately runs for four minutes read
 * as a hang. The list below is what the window draws, and it is only useful if
 * it is the pipeline's actual list.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { RESEARCH_STAGES, STAGE_IDS, stageIndex } from "../src/core/research/stages.ts";

describe("the stage list", () => {
  it("is exactly the stages the pipeline checkpoints, in that order", () => {
    /* Read from the source, so adding a stage to the pipeline without adding
       it here fails rather than quietly showing the user a shorter run than
       the one they are waiting on. */
    const source = readFileSync(new URL("../src/core/research/pipeline.ts", import.meta.url), "utf8");
    const seen: string[] = [];
    for (const m of source.matchAll(/checkpoint\("([a-z]+)"\)/g)) {
      const id = m[1]!;
      if (!seen.includes(id)) seen.push(id);
    }
    assert.deepEqual(STAGE_IDS, seen);
  });

  it("gives every stage words a person would use", () => {
    for (const stage of RESEARCH_STAGES) {
      assert.ok(stage.label.length > 2, stage.id);
      assert.ok(stage.hint.endsWith("."), `${stage.id} hint is a sentence`);
      // The label is for a reader, so it is never just the pipeline's own id.
      assert.notEqual(stage.label.toLowerCase(), stage.id);
    }
  });

  it("orders them so a position in the run is meaningful", () => {
    assert.equal(stageIndex("scope"), 0);
    assert.ok(stageIndex("plan") < stageIndex("discover"));
    assert.ok(stageIndex("synthesize") < stageIndex("verify"));
    assert.equal(stageIndex("revise"), RESEARCH_STAGES.length - 1);
    // A name that is not a stage must not read as the first one.
    assert.equal(stageIndex("nonsense"), -1);
  });
});
