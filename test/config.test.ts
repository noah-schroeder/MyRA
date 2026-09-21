/**
 * Settings a previous build could write and this one must survive.
 *
 * The timeout clamp is not hypothetical. A real config on this machine held
 * `llm.timeoutMs: 1000`, which the Settings field cannot produce -- it is in
 * seconds and clamps at 5 -- and which gave every request a one-second
 * deadline. It presented as "the LLM endpoint did not answer", so it read as a
 * broken endpoint rather than as a stored number, which is the expensive kind
 * of wrong.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  ConfigStore, DEFAULT_SETTINGS, LEGACY_REASONING, type Settings,
} from "../src/core/config.ts";
import { CONFIG_DIR } from "../src/core/paths.ts";

const SETTINGS = join(CONFIG_DIR, "settings.json");

async function withSettings(body: unknown, fn: (s: ConfigStore) => Promise<void>): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(SETTINGS, JSON.stringify(body));
  try {
    const store = new ConfigStore();
    await store.load();
    await fn(store);
  } finally {
    await rm(SETTINGS, { force: true });
  }
}

test("a timeout the UI could not have written is not honoured", async () => {
  await withSettings({ llm: { baseUrl: "http://x/v1", timeoutMs: 1000 } }, async (store) => {
    assert.equal(store.current.llm.timeoutMs, DEFAULT_SETTINGS.llm.timeoutMs);
    // The rest of the endpoint is kept: only the impossible field is replaced.
    assert.equal(store.current.llm.baseUrl, "http://x/v1");
  });
});

test("a timeout a person deliberately chose is left alone", async () => {
  await withSettings({ llm: { baseUrl: "http://x/v1", timeoutMs: 15_000 } }, async (store) => {
    assert.equal(store.current.llm.timeoutMs, 15_000);
  });
});

test("a missing or corrupt timeout falls back rather than becoming NaN", async () => {
  await withSettings({ llm: { baseUrl: "http://x/v1" } }, async (store) => {
    assert.equal(store.current.llm.timeoutMs, DEFAULT_SETTINGS.llm.timeoutMs);
  });
  await withSettings({ embeddings: { timeoutMs: "soon" } }, async (store) => {
    assert.equal(store.current.embeddings.timeoutMs, DEFAULT_SETTINGS.embeddings.timeoutMs);
  });
});

test("an endpoint written before it existed keeps its env var", async () => {
  // A file holding only a baseUrl must not drop envVar, or the API key has
  // nowhere to arrive.
  await withSettings({ embeddings: { baseUrl: "http://e/v1" } }, async (store) => {
    assert.equal(store.current.embeddings.envVar, DEFAULT_SETTINGS.embeddings.envVar);
  });
});

test("an image size the picker could not have written is not honoured", async () => {
  /* Shape, not membership: the three sizes MyRA offers are what it shows, not
     what an engine accepts, so 1152x896 from a hand-edited file is fine and
     "huge" is not -- that string would go straight into a request body. */
  await withSettings({ image: { model: "sd-turbo", size: "huge" } }, async (store) => {
    assert.equal(store.current.image.size, DEFAULT_SETTINGS.image.size);
    assert.equal(store.current.image.model, "sd-turbo");
  });
  await withSettings({ image: { size: "1152x896" } }, async (store) => {
    assert.equal(store.current.image.size, "1152x896");
  });
});

test("an image block that is not one falls back to the defaults", async () => {
  await withSettings({ image: "sd-turbo" }, async (store) => {
    assert.deepEqual(store.current.image, DEFAULT_SETTINGS.image);
  });
});

test("changing the image model does not send the size back with it", async () => {
  /* The reason update() merges this block rather than replacing it: the picker
     in the top bar knows which model was chosen and nothing about the size
     chosen on the page. The cast is what a caller sending half a block looks
     like from here; the type asks for the whole block precisely so that
     spreading is the easy path. */
  await withSettings({ image: { model: "a", size: "1024x1024" } }, async (store) => {
    await store.update({ image: { model: "b" } } as Partial<Settings>);
    assert.equal(store.current.image.model, "b");
    assert.equal(store.current.image.size, "1024x1024");
  });
});

test("a thinking level stored before dialects were plural is kept", async () => {
  // An older build wrote one level per model, because a model was found to
  // read one switch. Dropping those on upgrade would silently un-choose a
  // setting the user made, with nothing on screen saying so.
  await withSettings({ reasoning: { "qwen3:8b": "high", junk: 5 } }, async (store) => {
    assert.deepEqual(store.current.reasoning["qwen3:8b"], { [LEGACY_REASONING]: "high" });
    assert.equal(store.current.reasoning["junk"], undefined);
  });
});

test("two switches on one model are stored apart", async () => {
  // The reason for the nesting: a model reading both `enable_thinking` and
  // `reasoning_effort` has two independent answers, and one value per model
  // could only ever record whichever was touched last.
  const stored = {
    reasoning: {
      "qwen3:8b": { "template:enable_thinking": "true", "template:reasoning_effort": "high" },
    },
  };
  await withSettings(stored, async (store) => {
    assert.deepEqual(store.current.reasoning["qwen3:8b"], {
      "template:enable_thinking": "true",
      "template:reasoning_effort": "high",
    });
    // Un-choosing everything removes the model rather than leaving an empty
    // row a later reader would have to interpret.
    await store.update({ reasoning: { "qwen3:8b": {} } });
    assert.equal(store.current.reasoning["qwen3:8b"], undefined);
  });
});

test("a persona is per model, and clearing one is expressible", async () => {
  await withSettings({ persona: "You are Hilde.", systemPrompts: { "a::b": "Be terse." } }, async (store) => {
    assert.equal(store.current.persona, "You are Hilde.");
    assert.deepEqual(store.current.systemPrompts, { "a::b": "Be terse." });

    /* Replaced wholesale like sampling and reasoning: a merge could not say
       "this model no longer has one". */
    await store.update({ systemPrompts: {} });
    assert.deepEqual(store.current.systemPrompts, {});
  });
});

test("a blank persona for a model is not an entry", async () => {
  await withSettings({ systemPrompts: { "a::b": "   ", "c::d": "Real." } }, async (store) => {
    assert.deepEqual(store.current.systemPrompts, { "c::d": "Real." });
  });
});

test("the persona falls back to MyRA's own rather than to nothing", async () => {
  await withSettings({ persona: 42 }, async (store) => {
    assert.equal(store.current.persona, DEFAULT_SETTINGS.persona);
    assert.match(store.current.persona, /You are Myra/);
  });
});

test("reviews have a root of their own, beside papers", async () => {
  await withSettings({}, async (store) => {
    assert.ok(store.current.reviewsRoot.endsWith("reviews"));
    assert.notEqual(store.current.reviewsRoot, store.current.papersRoot);
  });
});

test("the v1 GNOME dictation keybinding is dropped, not carried forward", async () => {
  await withSettings({ dictationHotkey: "<Super>d" }, async (store) => {
    assert.deepEqual(store.current.hotkeys, DEFAULT_SETTINGS.hotkeys);

    // The migration's own effect is what stops it running twice: the next
    // save must not write the old key back out.
    await store.update({});
    const written = JSON.parse(await readFile(SETTINGS, "utf8")) as Record<string, unknown>;
    assert.ok(!("dictationHotkey" in written));
  });
});

test("a stored hotkeys block is rebuilt field by field", async () => {
  await withSettings({ hotkeys: { dictation: "ctrl+shift+d", dictationMode: "wobble", handsFree: "<Super>d" } }, async (store) => {
    assert.equal(store.current.hotkeys.dictation, "Ctrl+Shift+D");
    // An unrecognised mode falls back to the default rather than the file's word.
    assert.equal(store.current.hotkeys.dictationMode, "toggle");
    // Not one of ours -- same as any stored value that isn't a combo.
    assert.equal(store.current.hotkeys.handsFree, "");
  });
});

test("clearing a hotkey's combo does not lose the mode beside it", async () => {
  await withSettings({}, async (store) => {
    // Callers always spread the current block, the way the Audio pane does
    // for `audio` -- a patch names the field it changes, not a partial one.
    await store.update({ hotkeys: { ...store.current.hotkeys, dictation: "Ctrl+Shift+D", dictationMode: "hold" } });
    assert.equal(store.current.hotkeys.dictation, "Ctrl+Shift+D");
    assert.equal(store.current.hotkeys.dictationMode, "hold");

    await store.update({ hotkeys: { ...store.current.hotkeys, dictation: "" } });
    assert.equal(store.current.hotkeys.dictation, "");
    assert.equal(store.current.hotkeys.dictationMode, "hold");
  });
});

/**
 * Every configurable folder is a jail root, so a stored value is an input.
 *
 * `meetingDir` and `resolveInJail` are both correct jails that resolve against
 * one of these. Handed "/", a correct jail contains the whole filesystem --
 * and `meeting-delete` walks it with `rm -rf`. The picker cannot produce these
 * values; a hand-edited settings.json and any build that ever wrote the field
 * can.
 */
test("a folder that cannot be a jail root falls back to the default", async () => {
  const stored = {
    meetingsRoot: "/",
    workspaceRoot: 42,
    imagesRoot: "relative/not/absolute",
    papersRoot: join(CONFIG_DIR, "papers"),
    reviewsRoot: homedir(),
    meetingReportDir: "../../",
    vaultWriteSubdir: "..\\..\\escape",
  };
  await withSettings(stored, async (store) => {
    assert.equal(store.current.meetingsRoot, DEFAULT_SETTINGS.meetingsRoot, "a filesystem root");
    assert.equal(store.current.workspaceRoot, DEFAULT_SETTINGS.workspaceRoot, "not even a string");
    assert.equal(store.current.imagesRoot, DEFAULT_SETTINGS.imagesRoot, "not absolute");
    assert.equal(store.current.papersRoot, DEFAULT_SETTINGS.papersRoot, "inside CONFIG_DIR");
    assert.equal(store.current.reviewsRoot, DEFAULT_SETTINGS.reviewsRoot, "the home directory itself");
    assert.equal(store.current.meetingReportDir, DEFAULT_SETTINGS.meetingReportDir, "a climb");
    assert.equal(store.current.vaultWriteSubdir, DEFAULT_SETTINGS.vaultWriteSubdir, "a win32 climb");
  });
});

test("a folder the user actually chose is left exactly as it is", async () => {
  const mine = join(homedir(), "Work", "myra-elsewhere");
  await withSettings({ workspaceRoot: mine, meetingsRoot: mine, vaultRoot: "", zoteroDataDir: "" }, async (store) => {
    assert.equal(store.current.workspaceRoot, mine);
    assert.equal(store.current.meetingsRoot, mine);
    /* Empty is a real answer for these two -- "no vault", "look in the usual
       places" -- and must not be replaced by a default that points somewhere. */
    assert.equal(store.current.vaultRoot, "");
    assert.equal(store.current.zoteroDataDir, "");
  });
});

test("a root the window sends is checked the same as one on disk", async () => {
  await withSettings({}, async (store) => {
    const before = store.current.meetingsRoot;
    await store.update({ meetingsRoot: "/" });
    assert.equal(store.current.meetingsRoot, before, "an unusable root keeps the one that worked");
    /* Kept, not reset to the packaged default: the value being replaced is
       the user's own working folder, and losing it is its own bug. */
    const mine = join(homedir(), "Work", "somewhere");
    await store.update({ meetingsRoot: mine });
    assert.equal(store.current.meetingsRoot, mine);
    await store.update({ persona: "unrelated" });
    assert.equal(store.current.meetingsRoot, mine, "a patch that names no root leaves it alone");
  });
});

/**
 * The `update()` path for the two settings a Settings box calls a jail root
 * "does not apply to" -- `meetingReportDir` is joined onto one rather than
 * being one, and `zoteroDataDir` accepts empty on purpose -- had only the
 * load path (`a folder that cannot be a jail root falls back to the
 * default`, above) pinned. A rejection that only happens on `update()` is
 * exactly what a typed keystroke exercises, which is what the Zotero and
 * Report-subfolder boxes send.
 */
test("a patch that cannot be a subdirectory keeps the one already stored", async () => {
  await withSettings({ meetingReportDir: "Meetings" }, async (store) => {
    // A trailing dot: what `safeRelativePath` refuses on Win32's own strip-on-open rule.
    await store.update({ meetingReportDir: "Notes." });
    assert.equal(store.current.meetingReportDir, "Meetings", "a rejected value is not written");
    await store.update({ meetingReportDir: "Weekly Notes" });
    assert.equal(store.current.meetingReportDir, "Weekly Notes", "an ordinary one still is");
  });
});

test("a patch that cannot be a root keeps the zotero folder already stored", async () => {
  const mine = join(homedir(), "Zotero");
  await withSettings({ zoteroDataDir: mine }, async (store) => {
    await store.update({ zoteroDataDir: "/" });
    assert.equal(store.current.zoteroDataDir, mine, "a filesystem root is refused");
    // Empty is a real answer for this one -- "look in the usual places" -- not a refusal.
    await store.update({ zoteroDataDir: "" });
    assert.equal(store.current.zoteroDataDir, "");
  });
});

test("hfTokenUse round-trips, and an unrecognised value is anonymous by default", async () => {
  // "gated" is the safer default -- anonymous unless a repository actually
  // needs the token -- so anything that is not literally "always" falls back
  // to it, the same ternary shape hotkeys.ts already uses for dictationMode.
  await withSettings({ hfTokenUse: "nonsense" }, async (store) => {
    assert.equal(store.current.hfTokenUse, "gated", "a value from neither state is anonymous, not a crash");
  });
  await withSettings({}, async (store) => {
    assert.equal(store.current.hfTokenUse, "gated", "the packaged default is anonymous");
    await store.update({ hfTokenUse: "always" });
    assert.equal(store.current.hfTokenUse, "always");
    await store.update({ persona: "unrelated" });
    assert.equal(store.current.hfTokenUse, "always", "a patch naming no token setting leaves it alone");
    await store.update({ hfTokenUse: "gated" });
    assert.equal(store.current.hfTokenUse, "gated");
  });
});

test("the corrected value is what gets written back", async () => {
  await withSettings({ meetingsRoot: "/" }, async (store) => {
    await store.update({ persona: "anything, to force a save" });
    const onDisk = JSON.parse(await readFile(SETTINGS, "utf8"));
    assert.equal(onDisk.meetingsRoot, DEFAULT_SETTINGS.meetingsRoot);
  });
});
