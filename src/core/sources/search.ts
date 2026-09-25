/**
 * Keyword search over a project's papers: SQLite's FTS5, in memory.
 *
 * Why this rather than embeddings: academic questions turn on exact terms --
 * a construct, an instrument, a method, an author -- which is what a ranked
 * keyword index is good at, and the model asking can rephrase and ask again.
 * What comes back is a literal passage with its page, so it can be quoted and
 * checked. Why it costs nothing: FTS5 is compiled into the SQLite that
 * `node:sqlite` already ships, the one the Zotero reader uses, so there is no
 * dependency to add. Why in memory: the index is rebuilt from the cached texts
 * whenever they change, so there is no index file on disk to go stale or to
 * explain.
 *
 * The model's query never reaches FTS5's own syntax. `ftsQuery` rebuilds it
 * from the words alone, because MATCH is a small language -- `NEAR`, column
 * filters, unbalanced quotes -- and a stray operator from a model is a thrown
 * error at best and a different question at worst.
 */

import { DatabaseSync } from "node:sqlite";

import type { Passage } from "./fulltext.ts";

/** FTS5's operators, which a model's query may contain as ordinary words. */
const OPERATORS = new Set(["and", "or", "not", "near"]);

/** Enough terms for a real question; a pasted paragraph is a mistake, not a query. */
const MAX_TERMS = 16;

/**
 * A model's query as a MATCH expression built only from its words.
 *
 * Quoted phrases stay phrases; every other word is its own quoted term, and
 * the lot is OR-joined -- BM25 already ranks a passage holding more of them
 * higher, and requiring all of them turns a natural question into no results.
 * `undefined` when nothing searchable is left.
 */
export function ftsQuery(query: string): string | undefined {
  const parts: string[] = [];
  const seen = new Set<string>();
  const add = (term: string): void => {
    const key = term.toLowerCase();
    if (!term || seen.has(key) || parts.length >= MAX_TERMS) return;
    seen.add(key);
    parts.push(`"${term}"`);
  };

  const phrases = [...query.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  const rest = query.replace(/"[^"]*"/g, " ");
  for (const phrase of phrases) {
    const words = tokens(phrase);
    if (words.length > 1) add(words.join(" "));
    else if (words[0]) add(words[0]);
  }
  for (const word of tokens(rest)) {
    if (OPERATORS.has(word.toLowerCase())) continue;
    add(word);
  }
  return parts.length ? parts.join(" OR ") : undefined;
}

/** Letters and digits only -- everything FTS5 could read as syntax is gone. */
function tokens(text: string): string[] {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 2 || /\d/.test(w));
}

export interface IndexedPassage extends Passage {
  /** Which paper, as the tools address it: `source:<id>` or a Zotero key. */
  paper: string;
}

export interface Hit extends IndexedPassage {
  /** BM25, lower is better -- only ever compared within one search. */
  score: number;
}

/**
 * One project's passages, searchable.
 *
 * Built once and kept while the texts it was built from are unchanged (the
 * caller decides that); `close` frees it. At most a few thousand passages for
 * a realistic project, which FTS5 indexes in well under a second.
 */
export class PaperIndex {
  private readonly db: DatabaseSync;
  readonly size: number;

  constructor(rows: Iterable<IndexedPassage>) {
    this.db = new DatabaseSync(":memory:");
    /* porter stems "adopting" and "adoption" together; unicode61 folds case
       and diacritics, so "Müller" finds "muller". */
    this.db.exec("CREATE VIRTUAL TABLE passages USING fts5(body, paper UNINDEXED, page UNINDEXED, section UNINDEXED, tokenize = 'porter unicode61')");
    const insert = this.db.prepare("INSERT INTO passages (body, paper, page, section) VALUES (?, ?, ?, ?)");
    let n = 0;
    this.db.exec("BEGIN");
    for (const row of rows) {
      insert.run(row.text, row.paper, row.page, row.section);
      n++;
    }
    this.db.exec("COMMIT");
    this.size = n;
  }

  /**
   * The best passages for a query, at most `perPaper` from any one paper --
   * one long paper that uses the word on every page must not be the whole
   * answer, when the question was which papers say something about it.
   */
  search(query: string, opts: { limit?: number; perPaper?: number; papers?: readonly string[] } = {}): Hit[] {
    const match = ftsQuery(query);
    if (!match) return [];
    const limit = Math.min(Math.max(opts.limit ?? 8, 1), 30);
    const perPaper = opts.perPaper ?? 3;
    const only = opts.papers?.length ? new Set(opts.papers) : undefined;
    const rows = this.db
      .prepare("SELECT body, paper, page, section, bm25(passages) AS score FROM passages WHERE passages MATCH ? ORDER BY score LIMIT ?")
      .all(match, limit * 10) as { body: string; paper: string; page: number; section: string; score: number }[];

    const out: Hit[] = [];
    const taken = new Map<string, number>();
    for (const row of rows) {
      if (only && !only.has(row.paper)) continue;
      const n = taken.get(row.paper) ?? 0;
      if (n >= perPaper) continue;
      taken.set(row.paper, n + 1);
      out.push({ paper: row.paper, page: Number(row.page), section: row.section, text: row.body, score: row.score });
      if (out.length >= limit) break;
    }
    return out;
  }

  close(): void {
    this.db.close();
  }
}
