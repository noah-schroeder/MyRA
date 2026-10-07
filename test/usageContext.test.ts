/**
 * Who a call was for travels with the work, not with the arguments.
 *
 * The property that matters is isolation: a review and a chat turn overlap in
 * time on the same event loop, and a research run's stage label must never
 * land on somebody else's calls.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { currentUsageTags, noteUsageStage, withUsage } from "../src/core/usage/context.ts";

const tick = (ms = 1): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("withUsage", () => {
  it("adds to the tags already in force", async () => {
    await withUsage({ feature: "chat", project: { id: "p1", name: "Thesis" } }, async () => {
      await withUsage({ feature: "compaction" }, async () => {
        await tick();
        const tags = currentUsageTags();
        assert.equal(tags.feature, "compaction");
        assert.deepEqual(tags.project, { id: "p1", name: "Thesis" }, "the outer project is inherited");
      });
      assert.equal(currentUsageTags().feature, "chat", "and the outer feature is back afterwards");
    });
  });

  it("follows the work through awaits and timers", async () => {
    await withUsage({ feature: "review" }, async () => {
      await tick(5);
      await Promise.resolve();
      const later = await new Promise<string | undefined>((resolve) =>
        setTimeout(() => resolve(currentUsageTags().feature), 2),
      );
      assert.equal(later, "review");
    });
  });

  it("keeps two overlapping pieces of work apart", async () => {
    const seen: string[] = [];
    await Promise.all([
      withUsage({ feature: "review" }, async () => {
        await tick(3);
        seen.push(`a:${currentUsageTags().feature}`);
      }),
      withUsage({ feature: "paper" }, async () => {
        await tick(1);
        seen.push(`b:${currentUsageTags().feature}`);
      }),
    ]);
    assert.deepEqual(seen.sort(), ["a:review", "b:paper"]);
  });

  it("is empty outside any of them", () => {
    assert.deepEqual(currentUsageTags(), {});
  });
});

describe("noteUsageStage", () => {
  it("labels the rest of a research run's calls, and only that run's", async () => {
    let other: string | undefined = "unset";
    await Promise.all([
      withUsage({ feature: "research" }, async () => {
        noteUsageStage("screen");
        await tick(2);
        assert.equal(currentUsageTags().stage, "screen");
      }),
      withUsage({ feature: "chat" }, async () => {
        await tick(4);
        other = currentUsageTags().stage;
      }),
    ]);
    assert.equal(other, undefined);
  });

  it("does nothing outside a research run", async () => {
    await withUsage({ feature: "chat" }, async () => {
      noteUsageStage("screen");
      assert.equal(currentUsageTags().stage, undefined);
    });
  });

  it("does not follow into a different feature started inside the run", async () => {
    await withUsage({ feature: "research" }, async () => {
      noteUsageStage("extract");
      await withUsage({ feature: "document" }, async () => {
        assert.equal(currentUsageTags().stage, undefined);
      });
    });
  });
});
