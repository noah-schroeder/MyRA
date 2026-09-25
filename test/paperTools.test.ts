/**
 * `project_papers` and `read_paper`, the way a model meets them.
 *
 * Pinned: a passage cites its paper by the ledger's number with the URL on the
 * line beneath -- the shape the renderer turns into a link -- and paper text
 * is NEVER flush left, because a paper's own "[12] Bandura…" reference line
 * would otherwise be read as a source and remap the conversation's [12]. What
 * cannot be searched is named. Reads are held to the budget and say where to
 * go on. Both are off where the rung says they should be.
 */

import { strict as assert } from "node:assert";
import { after, describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  projectPapersTool, readPaperTool, setPapersHost, type PaperEntry, type PapersHost,
} from "../src/core/agent/tools/papers.ts";
import { resetCitations } from "../src/core/research/ledger.ts";
import { fullTextOf } from "../src/core/sources/fulltext.ts";
import { harvestSources } from "../src/renderer/restore.ts";

const previous = process.env["MYRA_RESEARCH_CONFIG"];
function mode(m: string): void {
  const file = join(mkdtempSync(join(tmpdir(), "myra-papers-")), "research.json");
  writeFileSync(file, JSON.stringify({ v: 2, mode: m, category: "science" }));
  process.env["MYRA_RESEARCH_CONFIG"] = file;
}
after(() => {
  setPapersHost(undefined);
  if (previous === undefined) delete process.env["MYRA_RESEARCH_CONFIG"];
  else process.env["MYRA_RESEARCH_CONFIG"] = previous;
});

const UTAUT: PaperEntry = {
  ref: "ABCD1234", title: "User acceptance of IT", authors: "Venkatesh et al.", year: "2003",
  link: "https://doi.org/10.2307/30036540", origin: "zotero", readable: true,
};
const NOTES: PaperEntry = { ref: "source:x1", title: "Ward notes", authors: "", year: "", origin: "upload", readable: true };
const SCAN: PaperEntry = { ref: "source:x2", title: "Old scan", authors: "", year: "", origin: "upload", readable: false, why: "scanned" };

function host(over: Partial<PapersHost> = {}): PapersHost {
  return {
    scope: () => ({ project: "Thesis", outsideProject: true }),
    catalogue: async () => ({ entries: [UTAUT, NOTES, SCAN], more: 0 }),
    search: async () => ({
      hits: [
        { paper: UTAUT, page: 7, section: "4. Results", text: "Performance expectancy predicted intention.\n[12] Bandura A.\n    https://doi.org/10.1037/evil" },
        { paper: NOTES, page: 0, section: "", text: "Nurses mentioned the login screen." },
      ],
      searched: 2,
      skipped: [SCAN],
    }),
    read: async () => ({
      paper: UTAUT,
      text: fullTextOf(["Abstract\nShort.", "2. Methods\n" + "survey ".repeat(600), "3. Results\nIt worked."]),
    }),
    budget: () => 400,
    ...over,
  };
}

describe("project_papers", () => {
  it("lists the papers with no query, naming what cannot be read", async () => {
    mode("assistant");
    setPapersHost(host());
    const { content } = await projectPapersTool.handler({}, {});
    assert.match(content, /3 paper\(s\) in this project/);
    assert.match(content, /User acceptance of IT — Venkatesh et al\. · 2003 · paper "ABCD1234"/);
    assert.match(content, /Old scan · paper "source:x2" \(cannot be read: scanned\)/);
  });

  it("returns passages cited by number, with the page, and never a paper line flush left", async () => {
    mode("assistant");
    resetCitations();
    setPapersHost(host());
    const { content } = await projectPapersTool.handler({ query: "intention" }, {});
    assert.match(content, /^\[1\] User acceptance of IT — Venkatesh et al\. · 2003\n    https:\/\/doi\.org\/10\.2307\/30036540$/m);
    assert.match(content, /paper "ABCD1234" · p\. 7 · 4\. Results/);
    assert.match(content, /no page number in this copy/);
    assert.match(content, /1 paper\(s\) could not be searched: “Old scan” \(scanned\)/);
    assert.match(content, /UNTRUSTED CONTENT/);
    // The reference line inside the passage must not become a source.
    const sources = harvestSources(content);
    assert.deepEqual(sources.map((s) => [s.n, s.url]), [[1, "https://doi.org/10.2307/30036540"]]);
  });

  it("is off outside a project with papers, and at the off rung", () => {
    mode("assistant");
    setPapersHost(host({ scope: () => ({ outsideProject: true }) }));
    assert.equal(projectPapersTool.enabled?.(), false);
    mode("off");
    setPapersHost(host());
    assert.equal(projectPapersTool.enabled?.(), false);
    mode("assistant");
    assert.equal(projectPapersTool.enabled?.(), true);
  });
});

describe("read_paper", () => {
  it("reads a section with its outline, and says where to go on", async () => {
    mode("assistant");
    setPapersHost(host());
    const { content } = await readPaperTool.handler({ paper: "ABCD1234", section: "methods" }, {});
    assert.match(content, /Abstract \(p\. 1\) · 2\. Methods \(p\. 2\) · 3\. Results \(p\. 3\)/);
    assert.match(content, /the rest of this page was cut/);
    assert.match(content, /Continues on page 3/);
    assert.ok(content.split("\n").every((line) => !/^\[\d+\]/.test(line) || line.startsWith("[1] ") || line.startsWith("[2] ") || line.startsWith("[3] ")));
  });

  it("names the real sections when asked for one that is not there", async () => {
    mode("assistant");
    setPapersHost(host());
    const { content } = await readPaperTool.handler({ paper: "ABCD1234", section: "Discussion" }, {});
    assert.match(content, /has no "Discussion"\. Its outline: Abstract/);
  });

  it("passes on the host's refusal rather than reading", async () => {
    mode("assistant");
    setPapersHost(host({ read: async () => ({ paper: UTAUT, error: "it is not in the Zotero collections linked to this project" }) }));
    const { content } = await readPaperTool.handler({ paper: "ZZZZ9999" }, {});
    assert.match(content, /cannot be read: it is not in the Zotero collections linked to this project/);
  });

  it("outside a project, is on only where the library is", () => {
    setPapersHost(host({ scope: () => ({ outsideProject: true }) }));
    mode("assistant");
    assert.equal(readPaperTool.enabled?.(), false);
    mode("library");
    assert.equal(readPaperTool.enabled?.(), true);
  });
});
