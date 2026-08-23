/**
 * Turning SearXNG's /config into the category list the GUI offers.
 *
 * The subtlety is the `enabled` field on each engine. It looks like "is this
 * engine switched on for this instance", and it is not: it is the DEFAULT STATE
 * OF THE TOGGLE on SearXNG's own preferences page, which each visitor overrides
 * in a browser cookie. An API request carries no such cookie, and SearXNG
 * queries the category's engines regardless.
 *
 * Measured against a live instance:
 *   - `scientific publications` reports 4 enabled engines, and a search of that
 *     category answers from 6 (crossref and openalex both report enabled:false).
 *   - `books` reports ZERO enabled engines, and a search of it still returns
 *     results from openlibrary.
 *
 * So filtering on `enabled` understated every category and dropped working ones
 * out of the dropdown entirely. The honest count is every engine SearXNG lists
 * under the category.
 */

export interface SearxngConfigBody {
  categories?: string[];
  engines?: {
    name?: string;
    enabled?: boolean;
    categories?: string[];
    time_range_support?: boolean;
  }[];
}

export interface CategoryCount {
  name: string;
  engines: number;
  /**
   * Whether any engine here honours a time filter.
   *
   * Reported so the GUI can stop offering a control that does nothing: when no
   * engine supports it, SearXNG drops them all and the search returns zero
   * results rather than unfiltered ones. No scholarly engine supports it.
   */
  timeRange: boolean;
}

export function categoriesFromConfig(body: SearxngConfigBody): CategoryCount[] {
  const counts = new Map<string, number>();
  const timed = new Set<string>();
  for (const engine of body.engines ?? []) {
    for (const category of engine.categories ?? []) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
      if (engine.time_range_support === true) timed.add(category);
    }
  }
  return (body.categories ?? [])
    .filter((c) => (counts.get(c) ?? 0) > 0)
    .map((c) => ({ name: c, engines: counts.get(c) ?? 0, timeRange: timed.has(c) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
