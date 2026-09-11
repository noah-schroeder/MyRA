/**
 * The literature databases this build searches, by name.
 *
 * Its own module, with no imports, for two reasons. It has to be readable from
 * the renderer, and the provider list is not -- that file reaches the network
 * clients, which reach the config reader, which reads the filesystem, none of
 * which belongs in a browser bundle. And it has to be the SAME list the search
 * actually uses, or the bar would be naming databases nobody queried.
 *
 * The second half is what the test enforces: every scholarly provider's id
 * appears here, and nothing here is missing from the providers. A database
 * added or dropped shows up on the bar, or the suite fails.
 *
 * Two of these four need a key -- CORE requires one on every request, and
 * PubMed's own free tier is so easy to exceed on a multi-query deep run that
 * it is offered under the same rule -- and this table is what a database is
 * offered as disabled *for*: `secret` says which vault entry to check, and
 * `signup` is where a user without one is sent.
 */

export type DatabaseId = "openalex" | "arxiv" | "pubmed" | "core";

/** The vault names for database keys. Mirrored in core/secretNames.ts. */
export type DatabaseSecret = "ncbiKey" | "coreKey";

export interface DatabaseInfo {
  /** Matches the SearchProvider id, and is what research.json/plan.md store. */
  readonly id: DatabaseId;
  /** The name on screen, and the name written into a plan's Limits block. */
  readonly label: string;
  /** Absent means keyless. Present means unusable until that secret is set. */
  readonly secret?: DatabaseSecret;
  /** Where to get a key. Shown beside a database that has none. */
  readonly signup?: string;
  /** One line, for the picker's tooltip and the settings pane. */
  readonly covers: string;
}

/** In the order they are asked, which is the order the bar names them. */
export const DATABASES: readonly DatabaseInfo[] = [
  {
    id: "openalex",
    label: "OpenAlex",
    covers: "Everything with a DOI — 250M works across every field.",
  },
  {
    id: "arxiv",
    label: "arXiv",
    covers: "Preprints in physics, maths, computer science and statistics.",
  },
  {
    id: "pubmed",
    label: "PubMed",
    secret: "ncbiKey",
    signup: "https://www.ncbi.nlm.nih.gov/account/settings/",
    covers: "Biomedicine, nursing, public health and clinical trials.",
  },
  {
    id: "core",
    label: "CORE",
    secret: "coreKey",
    signup: "https://core.ac.uk/services/api",
    covers: "Open-access full text from institutional repositories worldwide.",
  },
];

/** Kept for the places that only want the display strings. */
export const SCHOLARLY_DATABASES = DATABASES.map((d) => d.label);

/**
 * The databases a fresh install searches: the two that need no key, so an
 * existing config with no `databases` field behaves exactly as it always has.
 */
export const DEFAULT_DATABASES: readonly DatabaseId[] = ["openalex", "arxiv"];

export function databaseById(id: string): DatabaseInfo | undefined {
  return DATABASES.find((d) => d.id === id);
}

/** For parsing a plan's `## Limits` block, which stores labels, not ids. */
export function databaseByLabel(label: string): DatabaseInfo | undefined {
  const wanted = label.trim().toLowerCase();
  return DATABASES.find((d) => d.label.toLowerCase() === wanted);
}

/**
 * "OpenAlex · arXiv" — over whatever is actually chosen, so the bar never
 * names a database nobody queried.
 *
 * Called with nothing, names every database this build knows about -- the
 * settings-pane case, where there is no "chosen" set yet.
 */
export function databaseLabel(chosen?: readonly string[]): string {
  if (!chosen || chosen.length === 0) return SCHOLARLY_DATABASES.join(" · ");
  const ids = new Set(chosen);
  const labels = DATABASES.filter((d) => ids.has(d.id)).map((d) => d.label);
  return (labels.length ? labels : SCHOLARLY_DATABASES).join(" · ");
}
