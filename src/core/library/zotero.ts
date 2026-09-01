/**
 * The user's own Zotero library, over Zotero's local HTTP API.
 *
 * This is a different question from the one `academic_research` answers. That
 * one searches OpenAlex and arXiv -- the whole literature, most of which the
 * user has never seen. This searches the few hundred papers they have already
 * decided matter, with metadata they have already corrected.
 *
 * Two things follow from that, and both are why it is worth having:
 *
 *   - It is local. `localhost:23119`, no key, nothing leaves the machine, so it
 *     belongs at the same rung as the document tools rather than behind the
 *     searching ones.
 *   - Its citations are real. A Zotero record carries a DOI and canonical
 *     author names that a person entered or fixed, which is a better basis for
 *     a citation than anything scraped from a page -- and far better than the
 *     nothing a draft has.
 *
 * ## What this cannot promise
 *
 * `abstractNote` is frequently empty. Zotero fills it from whatever translator
 * imported the item, and plenty of sources supply none, so a library can hold
 * hundreds of items with titles and no abstracts at all. Every result therefore
 * says whether it has one rather than implying that a missing abstract means a
 * missing paper.
 */

export const ZOTERO_HOST = "127.0.0.1";
export const ZOTERO_PORT = 23119;

/**
 * The local API serves one user, always numbered zero.
 *
 * There is no account here to have an id: `users/0` is the documented local
 * prefix, and it is not the user's zotero.org user id.
 */
export const ZOTERO_PREFIX = "users/0";

/** Enough of a Zotero item to cite it and to judge whether it is the one. */
export interface LibraryItem {
  key: string;
  itemType: string;
  title: string;
  /** Formatted for reading: "Smith, Jones & Patel". Empty when there are none. */
  creators: string;
  /** The year alone. Zotero stores dates in many shapes; only the year is safe. */
  year: string;
  abstract: string;
  publication: string;
  doi: string;
  url: string;
  tags: string[];
  collections: number;
}

export type SearchMode = "everything" | "titleCreatorYear";

/**
 * Where to look.
 *
 * "everything" is the default because it is the one that justifies the feature:
 * it reaches note text and the indexed full text of attached PDFs, so a library
 * of papers answers questions its titles never could. "titleCreatorYear" exists
 * for the case where that is too broad -- a common word matching every PDF in
 * the library is a real outcome on a large one.
 */
export function searchPath(opts: {
  query: string;
  limit?: number;
  mode?: SearchMode;
}): string {
  const params = new URLSearchParams({
    q: opts.query,
    qmode: opts.mode ?? "everything",
    // Attachments and notes are children of the items worth showing; listing
    // them alongside their parents is noise that reads as duplicates.
    itemType: "-attachment || note",
    limit: String(Math.min(Math.max(Math.floor(opts.limit ?? 25), 1), 100)),
    sort: "dateModified",
    direction: "desc",
  });
  return `/api/${ZOTERO_PREFIX}/items?${params.toString()}`;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * Names, in the order Zotero holds them.
 *
 * Capped at three plus "et al.", which is how they would be cited anyway, and
 * which stops a paper with ninety authors from filling the reply on its own.
 * Zotero has two creator shapes -- two-field and single-field -- and an item
 * imported from a bad translator has the whole name in `lastName`.
 */
export function formatCreators(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  const names = raw
    .map((c) => {
      if (!c || typeof c !== "object") return "";
      const row = c as Record<string, unknown>;
      return str(row["lastName"]) || str(row["name"]) || str(row["firstName"]);
    })
    .filter(Boolean);
  if (names.length === 0) return "";
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} et al.`;
}

/**
 * The year, and only the year.
 *
 * Zotero's `date` is free text -- "2020-03", "March 2020", "n.d.", "2020-03-15"
 * -- because it preserves whatever the source said. `meta.parsedDate` is
 * Zotero's own normalisation and is preferred when present. Anything that is
 * not four digits is dropped rather than guessed at.
 */
export function yearOf(data: Record<string, unknown>, meta: Record<string, unknown>): string {
  for (const candidate of [str(meta["parsedDate"]), str(data["date"])]) {
    const found = /\b(1\d{3}|20\d{2})\b/.exec(candidate);
    if (found) return found[1]!;
  }
  return "";
}

export function parseItems(body: unknown): LibraryItem[] {
  if (!Array.isArray(body)) return [];
  const out: LibraryItem[] = [];
  for (const entry of body) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const data = (row["data"] ?? {}) as Record<string, unknown>;
    const meta = (row["meta"] ?? {}) as Record<string, unknown>;
    const key = str(data["key"]) || str(row["key"]);
    const title = str(data["title"]);
    // A record with neither is not something a person can be shown.
    if (!key && !title) continue;
    out.push({
      key,
      itemType: str(data["itemType"]),
      title,
      creators: formatCreators(data["creators"]),
      year: yearOf(data, meta),
      abstract: str(data["abstractNote"]),
      publication:
        str(data["publicationTitle"]) || str(data["bookTitle"]) ||
        str(data["proceedingsTitle"]) || str(data["repository"]),
      doi: str(data["DOI"]),
      url: str(data["url"]),
      tags: Array.isArray(data["tags"])
        ? (data["tags"] as unknown[])
            .map((t) => (t && typeof t === "object" ? str((t as Record<string, unknown>)["tag"]) : ""))
            .filter(Boolean)
        : [],
      collections: Array.isArray(data["collections"]) ? data["collections"].length : 0,
    });
  }
  return out;
}

/** How much of an abstract goes into a reply before it crowds out the rest. */
const ABSTRACT_CHARS = 700;

/**
 * The library as text for the model.
 *
 * Every field is stated or explicitly absent. The point of searching a personal
 * library rather than the literature is that these records are trustworthy, and
 * a formatting that quietly omitted a missing abstract would undo exactly that:
 * the model would have no way to tell "no abstract stored" from "abstract not
 * shown", and would fill the gap.
 */
export function formatItems(items: LibraryItem[], query: string): string {
  if (items.length === 0) {
    return `Nothing in the Zotero library matches ${JSON.stringify(query)}.`;
  }
  const lines = items.map((item, i) => {
    const head = [
      `${i + 1}. ${item.title || "(untitled)"}`,
      [item.creators, item.year].filter(Boolean).join(" · "),
      item.publication,
      item.itemType,
    ]
      .filter(Boolean)
      .join(" — ");
    const ids = [
      item.doi ? `DOI ${item.doi}` : "",
      item.url,
      `Zotero key ${item.key}`,
    ]
      .filter(Boolean)
      .join(" · ");
    const abstract = item.abstract
      ? item.abstract.length > ABSTRACT_CHARS
        ? `${item.abstract.slice(0, ABSTRACT_CHARS).trimEnd()}…`
        : item.abstract
      : "(no abstract stored in Zotero for this item)";
    return [head, ids, abstract, item.tags.length ? `Tags: ${item.tags.join(", ")}` : ""]
      .filter(Boolean)
      .join("\n");
  });

  const withAbstract = items.filter((i) => i.abstract).length;
  return [
    `${items.length} item(s) from the user's own Zotero library, ` +
      `${withAbstract} with an abstract stored.`,
    "",
    lines.join("\n\n"),
  ].join("\n");
}

export class ZoteroError extends Error {
  override readonly name = "ZoteroError";
}

/**
 * Say what is wrong in terms of what the user would do about it.
 *
 * The two failures are indistinguishable from the reply alone and have
 * completely different fixes, so they must not share a message: nothing
 * listening on the port means Zotero is closed, and a 403 means it is running
 * with the local API switched off.
 */
export function describeFailure(status: number | undefined): string {
  if (status === 403) {
    return (
      "Zotero is running but its local API is switched off. Turn on " +
      "Settings → Advanced → “Allow other applications on this computer to " +
      "communicate with Zotero”, then try again."
    );
  }
  if (status === 404) {
    return (
      "Zotero answered but does not have the local API. It needs Zotero 7 or newer; " +
      "older versions do not serve one."
    );
  }
  if (status === undefined) {
    return (
      `Nothing is listening on ${ZOTERO_HOST}:${ZOTERO_PORT}, so Zotero does not appear to be ` +
      "running. Open Zotero and try again — the library is only readable while it is open."
    );
  }
  return `Zotero answered ${status}.`;
}
