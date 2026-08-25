/**
 * Choosing which cited works are worth screening.
 *
 * Forty included papers cite perhaps two thousand works between them. Taking
 * all of them would swamp screening with one-off references — a method paper
 * cited once for its statistics, a dataset, an unrelated aside — and cost more
 * than the original sweep did.
 *
 * Co-citation is the filter, and it is the reason this stage is worth having
 * rather than merely possible: a work cited by SEVERAL of the papers screening
 * already accepted is, by construction, shared ancestry of that literature.
 * That is precisely what keyword search misses, because the foundational paper
 * was written before the field settled on the words you searched for.
 */

export interface CoCited {
  /** OpenAlex work id. */
  id: string;
  /** How many of the seed papers cite it. */
  citedBy: number;
}

/**
 * Rank the works cited by these seeds, most co-cited first.
 *
 * `seeds` is one entry per seed paper, each the list of works it references.
 * Duplicates within a single seed are ignored — a paper citing the same work
 * twice is one citation, not two, and counting it twice would let one seed
 * push a reference over the threshold by itself.
 */
export function coCitedWorks(
  seeds: (string[] | undefined)[],
  opts: { threshold: number; limit: number; exclude?: (id: string) => boolean },
): CoCited[] {
  const counts = new Map<string, number>();
  for (const refs of seeds) {
    for (const ref of new Set(refs ?? [])) {
      if (opts.exclude?.(ref)) continue;
      counts.set(ref, (counts.get(ref) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= opts.threshold)
    // Ties broken by id so a run is reproducible rather than dependent on the
    // order OpenAlex happened to return references in.
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, opts.limit)
    .map(([id, citedBy]) => ({ id, citedBy }));
}

/**
 * How many seeds must cite a work before it is worth screening.
 *
 * Two, normally. With few seeds nothing would clear that — five papers rarely
 * share a reference — and a traversal that silently returns nothing is worse
 * than a slightly noisier one, so below that it falls back to one.
 */
export function coCitationThreshold(seedCount: number): number {
  return seedCount >= 5 ? 2 : 1;
}
