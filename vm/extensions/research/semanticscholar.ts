/**
 * Semantic Scholar: a genuinely independent second opinion on full text.
 *
 * Worth adding only because it is NOT another view of the same data. OpenAlex
 * ingests the Unpaywall dataset, so asking Unpaywall re-asks the same database;
 * measured over 124 paywalled works the two never disagreed once. Semantic
 * Scholar crawls and hosts PDFs itself, and it found copies neither had.
 *
 * The batch endpoint takes up to 500 ids per request, which is what makes this
 * cheap: a thirty-paper run costs one call rather than thirty, so the 1 req/s
 * unauthenticated limit never comes near being a constraint.
 */

import { FETCH_TIMEOUT_MS } from "./config.ts";

const BATCH_URL = "https://api.semanticscholar.org/graph/v1/paper/batch";
/** The API's documented ceiling. */
const MAX_IDS = 500;

export interface OpenAccessPdf {
  url: string;
  /**
   * GOLD/HYBRID/BRONZE are the publisher's own copy; GREEN is a repository
   * copy, which may be an accepted or submitted manuscript rather than the
   * version of record. The distinction drives the bibliography caveat.
   */
  status?: string;
}

interface S2Paper {
  externalIds?: { DOI?: string };
  openAccessPdf?: { url?: string; status?: string } | null;
}

/**
 * Ask for an open PDF for each DOI. Keyed by lower-cased DOI.
 *
 * Never throws: a rate limit or an outage must not fail a research run that has
 * already retrieved everything else it needs.
 */
export async function s2OpenAccessPdfs(
  dois: string[],
  signal?: AbortSignal,
): Promise<Map<string, OpenAccessPdf>> {
  const found = new Map<string, OpenAccessPdf>();
  const unique = [...new Set(dois.map((d) => d.toLowerCase()).filter(Boolean))];

  for (let i = 0; i < unique.length; i += MAX_IDS) {
    const chunk = unique.slice(i, i + MAX_IDS);
    let papers: (S2Paper | null)[];
    try {
      const res = await fetch(`${BATCH_URL}?fields=externalIds,openAccessPdf`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: chunk.map((d) => `DOI:${d}`) }),
        signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return found; // 429 or outage: keep whatever earlier chunks gave
      papers = (await res.json()) as (S2Paper | null)[];
    } catch {
      return found;
    }

    // The response is positional and includes nulls for ids it does not know,
    // so the request order is the only thing tying a result back to its DOI.
    for (const [j, paper] of papers.entries()) {
      const url = paper?.openAccessPdf?.url;
      if (!url) continue;
      const doi = paper?.externalIds?.DOI?.toLowerCase() ?? chunk[j];
      if (!doi) continue;
      found.set(doi, {
        url,
        ...(paper?.openAccessPdf?.status ? { status: paper.openAccessPdf.status } : {}),
      });
    }
  }
  return found;
}

/** True when the copy is a repository manuscript rather than the published version. */
export function isRepositoryCopy(status: string | undefined): boolean {
  return (status ?? "").toUpperCase() === "GREEN";
}
