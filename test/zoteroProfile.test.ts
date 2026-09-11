/**
 * Finding a library that is not where Zotero puts it by default.
 *
 * This is the case that made the whole integration look broken: a library
 * moved to a second disk misses every candidate, so the file route reported
 * nothing, so MyRA fell back to the local API's message — "Zotero does not
 * appear to be reachable" — said to somebody with Zotero open in front of
 * them. Zotero writes the real path into its own prefs.js, and reading it is
 * the difference between guessing and knowing.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  dataDirFromPrefs, looksLikeProfileDir, parseProfilesIni, profileRoots,
} from "../src/core/library/zoteroProfile.ts";
import { buildLibrary } from "./zoteroFixture.ts";

describe("reading Zotero's own preference", () => {
  it("finds the data directory the user moved their library to", () => {
    const prefs = [
      'user_pref("extensions.zotero.firstRun2", false);',
      'user_pref("extensions.zotero.dataDir", "/mnt/research/Zotero");',
      'user_pref("extensions.zotero.useDataDir", true);',
    ].join("\n");
    assert.equal(dataDirFromPrefs(prefs), "/mnt/research/Zotero");
  });

  it("ignores the path when Zotero says it is not using it", () => {
    /* Zotero keeps the old custom path after the user moves back to the
       default. Following it would open a library they have stopped using --
       which looks like success and is worse than finding nothing. */
    const prefs = [
      'user_pref("extensions.zotero.dataDir", "/mnt/old-disk/Zotero");',
      'user_pref("extensions.zotero.useDataDir", false);',
    ].join("\n");
    assert.equal(dataDirFromPrefs(prefs), undefined);
  });

  it("says nothing when the library is in the default place", () => {
    assert.equal(dataDirFromPrefs('user_pref("browser.startup.page", 3);'), undefined);
  });

  it("unescapes what prefs.js is: JavaScript source", () => {
    // A Windows path, as Zotero actually writes it.
    assert.equal(
      dataDirFromPrefs('user_pref("extensions.zotero.dataDir", "C:\\\\Users\\\\Ann\\\\Zotero");'),
      "C:\\Users\\Ann\\Zotero",
    );
    // A name with an accent in it, escaped the way JSON would.
    assert.equal(
      dataDirFromPrefs('user_pref("extensions.zotero.dataDir", "/home/andr\\u00e9/Zotero");'),
      "/home/andré/Zotero",
    );
  });
});

describe("profiles.ini", () => {
  const ini = [
    "[General]",
    "StartWithLastProfile=1",
    "",
    "[Profile0]",
    "Name=older",
    "IsRelative=1",
    "Path=9xyz1234.older",
    "",
    "[Profile1]",
    "Name=default",
    "IsRelative=1",
    "Path=abcd5678.default",
    "Default=1",
  ].join("\n");

  it("puts the default profile first, whatever order the file lists them in", () => {
    assert.deepEqual(parseProfilesIni(ini, "/home/me/.zotero/zotero"), [
      "/home/me/.zotero/zotero/abcd5678.default",
      "/home/me/.zotero/zotero/9xyz1234.older",
    ]);
  });

  it("takes an absolute path as given", () => {
    const absolute = "[Profile0]\nIsRelative=0\nPath=/data/zotero-profile\nDefault=1";
    assert.deepEqual(parseProfilesIni(absolute, "/home/me/.zotero/zotero"), ["/data/zotero-profile"]);
  });

  it("ignores the sections that are not profiles", () => {
    const other = "[General]\nPath=not-a-profile\n\n[Install123]\nDefault=abc\n";
    assert.deepEqual(parseProfilesIni(other, "/root"), []);
  });

  it("recognises the conventional folder names, for a profile with no ini", () => {
    assert.equal(looksLikeProfileDir("abcd5678.default"), true);
    assert.equal(looksLikeProfileDir("abcd5678.default-release"), true);
    assert.equal(looksLikeProfileDir("storage"), false);
  });
});

describe("where profiles live", () => {
  it("covers the sandboxes, which are exactly the installs that need this", () => {
    const roots = profileRoots("/home/me", {});
    assert.ok(roots.includes("/home/me/.zotero/zotero"), "native");
    assert.ok(
      roots.some((r) => r.includes(".var/app/org.zotero.Zotero")),
      "flatpak",
    );
    assert.ok(roots.some((r) => r.includes("/snap/")), "snap");
  });

  it("uses APPDATA on Windows when it is set", () => {
    const roots = profileRoots("C:/Users/Ann", { APPDATA: "C:/Users/Ann/AppData/Roaming" });
    assert.ok(roots.includes("C:/Users/Ann/AppData/Roaming/Zotero/Zotero"));
  });
});

describe("end to end, against a library nothing would have guessed", () => {
  it("follows the profile to a library on another disk, and reads it", async () => {
    /* The whole failing case, assembled: a library somewhere no candidate
       names, and a Zotero profile that says where it is. */
    const home = mkdtempSync(join(tmpdir(), "myra-home-"));
    const library = buildLibrary(
      [
        { key: "AAAA1111", fields: { title: "Worked example", abstractNote: "" } },
        { key: "BBBB2222", fields: { title: "Second paper" } },
        { key: "CCCC3333", fields: { title: "In the trash" }, trashed: true },
      ],
      [{ key: "COLL0001", name: "Reading" }],
    );

    const profile = join(home, ".zotero", "zotero", "abcd5678.default");
    mkdirSync(profile, { recursive: true });
    writeFileSync(
      join(home, ".zotero", "zotero", "profiles.ini"),
      "[Profile0]\nIsRelative=1\nPath=abcd5678.default\nDefault=1\n",
    );
    writeFileSync(
      join(profile, "prefs.js"),
      `user_pref("extensions.zotero.dataDir", ${JSON.stringify(library)});\n`,
    );

    const before = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      /* Imported here, after HOME is set: the module reads the environment
         when asked, not at load, and this test is the thing that proves it. */
      const { inspectLibraryFile, locateZoteroDataDir, setZoteroDataDir, forgetZoteroSnapshot } =
        await import("../src/main/runtime/zoteroSqlite.ts");
      setZoteroDataDir("");
      forgetZoteroSnapshot();

      const found = locateZoteroDataDir();
      assert.equal(found.path, library);
      assert.equal(found.source, "profile");
      assert.ok(
        found.profiles.some((p) => p.dataDir === library),
        "the profile it learned that from is reported, so the user can check it",
      );

      const report = await inspectLibraryFile();
      assert.equal(report.ok, true);
      // Two real items; the trashed one is not in the library any more.
      assert.equal(report.items, 2);
      assert.equal(report.collections, 1);
      assert.match(report.message, /2 items and 1 collection/);
      forgetZoteroSnapshot();
    } finally {
      if (before === undefined) delete process.env["HOME"];
      else process.env["HOME"] = before;
    }
  });

  it("says the named folder is empty rather than reading a different library", async () => {
    const home = mkdtempSync(join(tmpdir(), "myra-home-"));
    const real = buildLibrary([{ key: "AAAA1111", fields: { title: "Not this one" } }]);
    const profile = join(home, ".zotero", "zotero", "abcd5678.default");
    mkdirSync(profile, { recursive: true });
    writeFileSync(
      join(profile, "prefs.js"),
      `user_pref("extensions.zotero.dataDir", ${JSON.stringify(real)});\n`,
    );

    const before = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      const { inspectLibraryFile, setZoteroDataDir, forgetZoteroSnapshot } =
        await import("../src/main/runtime/zoteroSqlite.ts");
      forgetZoteroSnapshot();
      // The user pointed at the wrong folder. MyRA must say so, not quietly
      // read the library it found by itself -- that answer looks like success.
      setZoteroDataDir(join(home, "Documents", "not-a-library"));
      const report = await inspectLibraryFile();
      assert.equal(report.ok, false);
      assert.match(report.message, /no zotero\.sqlite in/i);
      /* The panel's own copy: it is rendered directly above the folder picker,
         so it points at the control rather than repeating the path list the
         panel already shows underneath it. */
      assert.match(report.message, /choose the folder below/i);
      assert.equal(/It looked in:/.test(report.message), false);

      /* The same finding as a TOOL error, where there is no panel: there the
         paths and the route to the setting are the whole of the help. */
      const { noLibraryHere, locateZoteroDataDir } = await import("../src/main/runtime/zoteroSqlite.ts");
      const spelled = noLibraryHere(locateZoteroDataDir(), { paths: true });
      assert.match(spelled, /It looked in:/);
      assert.match(spelled, /Settings → Library/);
      setZoteroDataDir("");
      forgetZoteroSnapshot();
    } finally {
      if (before === undefined) delete process.env["HOME"];
      else process.env["HOME"] = before;
    }
  });
});

describe("what the Library panel says when the file cannot be read", () => {
  it("does not claim the API failed, because the panel says otherwise beside it", async () => {
    /* Reported with a screenshot: the top card read "Zotero answered on the
       local API, with 20 collections" and the card under it began "Zotero's
       local API did not answer". The panel probes both routes independently,
       so the file route must speak only for itself. */
    const home = mkdtempSync(join(tmpdir(), "myra-home-"));
    const data = join(home, "Zotero");
    mkdirSync(data, { recursive: true });
    // A file at the right path that SQLite will refuse.
    writeFileSync(join(data, "zotero.sqlite"), "this is not a database");

    const before = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      const { inspectLibraryFile, setZoteroDataDir, forgetZoteroSnapshot } =
        await import("../src/main/runtime/zoteroSqlite.ts");
      forgetZoteroSnapshot();
      setZoteroDataDir(data);
      const report = await inspectLibraryFile();
      assert.equal(report.ok, false);
      assert.equal(/local API/i.test(report.message), false, report.message);
      // It still names the file it could not read, which is the actionable part.
      assert.match(report.message, /zotero\.sqlite could not be read/);
      setZoteroDataDir("");
      forgetZoteroSnapshot();
    } finally {
      if (before === undefined) delete process.env["HOME"];
      else process.env["HOME"] = before;
    }
  });
});
