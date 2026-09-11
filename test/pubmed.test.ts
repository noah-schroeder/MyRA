/**
 * PubMed's `efetch` XML, parsed with no network and no XML dependency --
 * `parsePubmedArticles` is split out from the fetch for exactly this.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parsePubmedArticles } from "../src/core/research/pubmed.ts";

const FIXTURE = `
<PubmedArticleSet>
<PubmedArticle>
  <MedlineCitation>
    <PMID Version="1">33221100</PMID>
    <Article>
      <ArticleTitle>Effects of X on Y: A randomized trial.</ArticleTitle>
      <Abstract>
        <AbstractText Label="BACKGROUND">Background text here.</AbstractText>
        <AbstractText Label="METHODS">Methods text here.</AbstractText>
        <AbstractText Label="RESULTS">Results text here.</AbstractText>
      </Abstract>
      <AuthorList>
        <Author><LastName>Smith</LastName><ForeName>Jane</ForeName></Author>
        <Author><LastName>Doe</LastName><ForeName>John</ForeName></Author>
      </AuthorList>
      <Journal>
        <JournalIssue><PubDate><Year>2021</Year></PubDate></JournalIssue>
        <Title>Journal of Testing</Title>
      </Journal>
    </Article>
  </MedlineCitation>
  <PubmedData>
    <ArticleIdList>
      <ArticleId IdType="pubmed">33221100</ArticleId>
      <ArticleId IdType="doi">10.1000/xyz123</ArticleId>
      <ArticleId IdType="pmc">PMC1234567</ArticleId>
    </ArticleIdList>
  </PubmedData>
</PubmedArticle>
<PubmedArticle>
  <MedlineCitation>
    <PMID Version="1">2</PMID>
    <Article>
      <ArticleTitle>A paper with no abstract.</ArticleTitle>
      <Journal><Title>Some Journal</Title></Journal>
    </Article>
  </MedlineCitation>
</PubmedArticle>
</PubmedArticleSet>
`;

test("a structured abstract's sections are joined, not truncated to the first", () => {
  const [first] = parsePubmedArticles(FIXTURE);
  assert.equal(first?.abstract, "Background text here. Methods text here. Results text here.");
});

test("a record with a DOI gets one; the identifiers and venue are read from the right blocks", () => {
  const [first] = parsePubmedArticles(FIXTURE);
  assert.equal(first?.pmid, "33221100");
  assert.equal(first?.title, "Effects of X on Y: A randomized trial.");
  assert.deepEqual(first?.authors, ["Jane Smith", "John Doe"]);
  assert.equal(first?.venue, "Journal of Testing");
  assert.equal(first?.year, 2021);
  assert.equal(first?.doi, "10.1000/xyz123");
  assert.equal(first?.pmcid, "PMC1234567");
});

test("an article with no abstract, no authors and no identifiers parses rather than throwing", () => {
  const [, second] = parsePubmedArticles(FIXTURE);
  assert.equal(second?.pmid, "2");
  assert.equal(second?.title, "A paper with no abstract.");
  assert.equal(second?.abstract, "");
  assert.deepEqual(second?.authors, []);
  assert.equal(second?.venue, "Some Journal");
  assert.equal(second?.doi, undefined);
  assert.equal(second?.pmcid, undefined);
});

test("empty input parses to no records, not an error", () => {
  assert.deepEqual(parsePubmedArticles(""), []);
  assert.deepEqual(parsePubmedArticles("<PubmedArticleSet></PubmedArticleSet>"), []);
});
