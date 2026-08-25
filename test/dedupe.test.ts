/**
 * The same paper found twice must become one source.
 *
 * With OpenAlex and arXiv as the only providers this is not an edge case: the
 * arXiv PDF and the OpenAlex record of the same preprint arrive under different
 * URLs on essentially every scholarly query, and a preprint and its published
 * version are separate records with different DOIs. Two candidates, two
 * sources and two bibliography numbers for one study means a reader counting
 * sources counts wrong, and one study's claim looks corroborated by two.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  collapseDuplicates,
  identityKey,
  isPreprintDoi,
  normalizeTitle,
  type Dedupable,
} from "../src/core/research/dedupe.ts";

test("a DOI in any form is the identity", () => {
  assert.equal(
    identityKey({ id: 1, url: "https://doi.org/10.1037/XGE0001234" }),
    "doi:10.1037/xge0001234",
  );
  // Recovered from a publisher URL that embeds it...
  assert.equal(
    identityKey({ id: 2, url: "https://link.springer.com/content/pdf/10.1007/s11192-021-04026-6.pdf" }),
    "doi:10.1007/s11192-021-04026-6",
  );
  // ...and from an arXiv link, which maps onto a real DOI.
  assert.equal(
    identityKey({ id: 3, url: "https://arxiv.org/pdf/2101.00001" }),
    "doi:10.48550/arxiv.2101.00001",
  );
  // No DOI anywhere: fall back to the URL, as before.
  assert.match(identityKey({ id: 4, url: "https://example.org/a/page" }), /^url:/);
});

test("the arXiv PDF and the OpenAlex record of one preprint collapse", () => {
  const rows: Dedupable[] = [
    { id: 1, url: "https://arxiv.org/pdf/2101.00001", title: "Scaling laws for neural language models", pdfUrl: "https://arxiv.org/pdf/2101.00001" },
    { id: 2, url: "https://doi.org/10.48550/arxiv.2101.00001", title: "Scaling laws for neural language models", year: 2021, citedBy: 900, abstract: "We study empirical scaling laws." },
  ];
  const { rows: out, merged } = collapseDuplicates(rows);
  assert.equal(out.length, 1);
  // Metadata from the OpenAlex record, the readable PDF from the arXiv hit.
  assert.equal(out[0]!.citedBy, 900);
  assert.equal(out[0]!.abstract, "We study empirical scaling laws.");
  assert.equal(out[0]!.pdfUrl, "https://arxiv.org/pdf/2101.00001");
  assert.equal(merged[0]!.by, "doi");
});

test("a preprint and its published version collapse to the published record", () => {
  const rows: Dedupable[] = [
    {
      id: 1,
      url: "https://doi.org/10.48550/arxiv.2101.09999",
      doi: "10.48550/arxiv.2101.09999",
      title: "Working memory training and far transfer: a registered replication",
      year: 2021,
      pdfUrl: "https://arxiv.org/pdf/2101.09999",
    },
    {
      id: 2,
      url: "https://doi.org/10.1016/j.intell.2022.101456",
      doi: "10.1016/j.intell.2022.101456",
      title: "Working memory training and far transfer: A registered replication",
      year: 2022,
      venue: "Intelligence",
      citedBy: 42,
    },
  ];
  const { rows: out, merged } = collapseDuplicates(rows);
  assert.equal(out.length, 1);

  // The citation is to the version of record...
  assert.equal(out[0]!.doi, "10.1016/j.intell.2022.101456");
  assert.equal(out[0]!.venue, "Intelligence");
  // ...but the readable copy is the preprint, and the entry must say so.
  assert.equal(out[0]!.pdfUrl, "https://arxiv.org/pdf/2101.09999");
  assert.match(out[0]!.note!, /not the version of record/);
  assert.equal(merged[0]!.by, "title");
});

test("different papers are never merged", () => {
  const rows: Dedupable[] = [
    { id: 1, url: "https://doi.org/10.1/a", doi: "10.1/a", title: "Working memory training in older adults", venue: "Psych Aging" },
    { id: 2, url: "https://doi.org/10.1/b", doi: "10.1/b", title: "Working memory training in younger adults", venue: "Psych Aging" },
  ];
  assert.equal(collapseDuplicates(rows).rows.length, 2);
});

test("short titles are never collapsed, however identical", () => {
  // "Erratum" and "Introduction" recur across unrelated papers, and a wrong
  // merge destroys a real source rather than tidying the list.
  const rows: Dedupable[] = [
    { id: 1, url: "https://doi.org/10.1/a", doi: "10.1/a", title: "Erratum" },
    { id: 2, url: "https://doi.org/10.1/b", doi: "10.1/b", title: "Erratum" },
  ];
  assert.equal(collapseDuplicates(rows).rows.length, 2);
  assert.ok(normalizeTitle("Erratum").length < 20);
});

test("collapsing preserves the order of what survives", () => {
  const rows: Dedupable[] = [
    { id: 1, url: "https://doi.org/10.1/a", doi: "10.1/a", title: "First paper about something at length" },
    { id: 2, url: "https://arxiv.org/pdf/2101.00002", title: "Second paper about something else at length" },
    { id: 3, url: "https://doi.org/10.48550/arxiv.2101.00002", title: "Second paper about something else at length", venue: "NeurIPS" },
    { id: 4, url: "https://doi.org/10.1/d", doi: "10.1/d", title: "Third paper about a third thing at length" },
  ];
  const { rows: out } = collapseDuplicates(rows);
  // Candidate ids and the screening shortlist both depend on this order, so a
  // collapsed pair stays in the position where it was FIRST seen.
  assert.equal(out.length, 3);
  assert.match(out[0]!.title!, /^First/);
  assert.match(out[1]!.title!, /^Second/);
  assert.match(out[2]!.title!, /^Third/);
  // The surviving row is the more complete record of the pair -- id 3, not the
  // bare arXiv hit that happened to be seen first.
  assert.equal(out[1]!.id, 3);
  assert.equal(out[1]!.venue, "NeurIPS");
});

test("preprint DOI prefixes are recognised", () => {
  assert.ok(isPreprintDoi("10.48550/arxiv.2101.00001"));
  assert.ok(isPreprintDoi("https://doi.org/10.1101/2020.01.01.900001"));
  assert.ok(isPreprintDoi("10.21203/rs.3.rs-12345/v1"));
  assert.ok(!isPreprintDoi("10.1016/j.intell.2022.101456"));
  assert.ok(!isPreprintDoi(undefined));
});

test("titles differing only in punctuation, case or accents are the same title", () => {
  assert.equal(
    normalizeTitle("Attention Is All You Need!"),
    normalizeTitle("attention is all you need"),
  );
  assert.equal(normalizeTitle("Émotion and memory"), normalizeTitle("Emotion and Memory"));
});
