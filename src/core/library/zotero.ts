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

/**
 * Both loopback addresses, tried in order.
 *
 * Zotero's own settings pane advertises `http://localhost:23119/api/`, and
 * "localhost" is not one address: it is 127.0.0.1 and ::1, and which one a
 * server ends up bound to depends on the resolver, the platform and — under
 * Flatpak — the sandbox. Karen dialled the v4 address alone, so a Zotero
 * listening on the v6 one was reported as "not running" while sitting there
 * plainly running, with the checkbox ticked and the URL on screen.
 *
 * Not resolved through "localhost" itself, because that would make the address
 * Karen connects to depend on /etc/hosts. Both entries here are loopback by
 * construction, which is the property the whole feature rests on.
 */
export const ZOTERO_HOSTS = ["127.0.0.1", "[::1]"] as const;

/** The first one, for messages that name a single address. */
export const ZOTERO_HOST = ZOTERO_HOSTS[0];
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
 * One of the user's own collections -- the folders down the left of Zotero.
 *
 * `parent` is Zotero's `parentCollection`, which is the key of the collection
 * above or `false` at the top level. Held as a string-or-undefined because the
 * `false` is a Zotero encoding, not something the rest of Karen should carry.
 */
export interface ZoteroCollection {
  key: string;
  name: string;
  parent?: string;
}

/** A collection as it is offered to the user: in tree order, with its depth. */
export interface CollectionNode extends ZoteroCollection {
  depth: number;
  /** "Projects › 2026 › Memory". What a result says it searched. */
  path: string;
  /** How many collections are below it. Zero means the choice has no subtlety. */
  children: number;
}

/**
 * Zotero's key shape, checked because a key becomes part of a URL PATH.
 *
 * Everything else this module puts in a URL goes through URLSearchParams, which
 * escapes it. A path segment does not, so this is the one input that could
 * otherwise reach outside `/api/users/0/` -- and the narrowness of this client
 * is the reason it is allowed to exist at all.
 */
const KEY_SHAPE = /^[A-Z0-9]{8}$/;

export function isCollectionKey(value: unknown): value is string {
  return typeof value === "string" && KEY_SHAPE.test(value);
}

export function parseCollections(body: unknown): ZoteroCollection[] {
  if (!Array.isArray(body)) return [];
  const out: ZoteroCollection[] = [];
  for (const entry of body) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const data = (row["data"] ?? {}) as Record<string, unknown>;
    const key = str(data["key"]) || str(row["key"]);
    const name = str(data["name"]);
    // A collection with no key cannot be searched and a collection with no name
    // cannot be chosen, so neither is worth offering.
    if (!isCollectionKey(key) || !name) continue;
    const parent = data["parentCollection"];
    out.push({ key, name, ...(isCollectionKey(parent) ? { parent } : {}) });
  }
  return out;
}

/**
 * The collections in the order they are read in Zotero: nested, alphabetical.
 *
 * Cycle-safe throughout. A parent chain is data from another program's
 * database, and a loop in it -- however it got there -- must come out as a
 * flat list, not a hang.
 */
export function collectionTree(collections: ZoteroCollection[]): CollectionNode[] {
  const byKey = new Map(collections.map((c) => [c.key, c]));
  const children = new Map<string | undefined, ZoteroCollection[]>();
  for (const c of collections) {
    /* A parent that is not in the list is not a parent: it is a dangling key,
       and the collection would otherwise vanish from the tree entirely. */
    const under = c.parent && byKey.has(c.parent) ? c.parent : undefined;
    const bucket = children.get(under);
    if (bucket) bucket.push(c);
    else children.set(under, [c]);
  }
  for (const bucket of children.values()) {
    bucket.sort((a, b) => a.name.localeCompare(b.name));
  }

  const out: CollectionNode[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | undefined, depth: number, prefix: string): void => {
    for (const c of children.get(parent) ?? []) {
      if (seen.has(c.key)) continue;
      seen.add(c.key);
      const path = prefix ? `${prefix} › ${c.name}` : c.name;
      out.push({ ...c, depth, path, children: descendantKeys(collections, c.key).length - 1 });
      walk(c.key, depth + 1, path);
    }
  };
  walk(undefined, 0, "");

  /* Anything the walk never reached, which means its parent chain loops. Shown
     at the top level rather than dropped, on the same reasoning as a dangling
     parent: a collection that exists in Zotero and is missing from the picker
     is one the user cannot choose and cannot see why. */
  for (const c of collections) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    out.push({ ...c, depth: 0, path: c.name, children: 0 });
  }
  return out;
}

/**
 * How many collections one search may fan out over.
 *
 * There is a fan-out at all because Zotero's own API is not recursive: asking
 * `/collections/<key>/items` for "Projects" returns nothing that lives in
 * "Projects › 2026". A researcher who files everything one level down and is
 * told their collection is empty has been told something false, and would have
 * no way to tell it from the paper genuinely not being there.
 *
 * Capped because the fan-out is one request each. Twenty-five is past any
 * subtree a person actually navigates, and the result says when it was reached
 * rather than quietly searching less than it claimed.
 */
export const MAX_FANOUT = 25;

/**
 * A collection and everything under it, the chosen one first.
 *
 * Breadth-first and visited-guarded: see collectionTree on why a cycle here is
 * a real possibility rather than a defensive flourish.
 */
export function descendantKeys(collections: ZoteroCollection[], root: string): string[] {
  const kids = new Map<string, string[]>();
  for (const c of collections) {
    if (!c.parent) continue;
    const bucket = kids.get(c.parent);
    if (bucket) bucket.push(c.key);
    else kids.set(c.parent, [c.key]);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [root];
  while (queue.length && out.length < MAX_FANOUT) {
    const key = queue.shift()!;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    queue.push(...(kids.get(key) ?? []));
  }
  return out;
}

export function collectionsPath(): string {
  return `/api/${ZOTERO_PREFIX}/collections`;
}

/**
 * Where to look.
 *
 * "everything" is the default because it is the one that justifies the feature:
 * it reaches note text and the indexed full text of attached PDFs, so a library
 * of papers answers questions its titles never could. "titleCreatorYear" exists
 * for the case where that is too broad -- a common word matching every PDF in
 * the library is a real outcome on a large one.
 */
/**
 * How much of the query to send.
 *
 * "full" is what we want; "plain" is `q` and `qmode` and nothing else.
 *
 * The local API is a different implementation from api.zotero.org and does not
 * document itself as accepting every search parameter the web API does -- the
 * pagination it omits is documented, the rest is not. A request that is refused
 * whole comes back as one status with no indication of WHICH parameter was
 * unwelcome, which is indistinguishable from the library being unreachable and
 * is exactly as useful to the user: not at all.
 *
 * So the extras are the part that can be dropped. Everything they do can be
 * done here instead -- the item filtering happens in `parseItems` regardless,
 * and ordering a list of twenty-five papers is not why anyone opened Karen.
 */
export type QueryTier = "full" | "plain";

export function searchPath(opts: {
  query: string;
  limit?: number;
  mode?: SearchMode;
  /** One collection to search inside. Everything, when absent. */
  collection?: string;
}, tier: QueryTier = "full"): string {
  const params = new URLSearchParams({
    q: opts.query,
    qmode: opts.mode ?? "everything",
    limit: String(Math.min(Math.max(Math.floor(opts.limit ?? 25), 1), 100)),
  });
  if (tier === "full") {
    /* Attachments and notes are children of the items worth showing, and listing
       them beside their parents reads as duplicates. Asked for here so the
       server does not spend the limit on them -- and done again in parseItems,
       because on the plain tier this line is not sent at all. */
    params.set("itemType", "-attachment || note");
    params.set("sort", "dateModified");
    params.set("direction", "desc");
  }
  /* The key is checked, not trusted, because unlike every other value here it
     lands in the path rather than the query string and is therefore not
     escaped. An unrecognisable key searches the whole library, which is the
     wider answer and so cannot be mistaken for a narrower one. */
  const scope = isCollectionKey(opts.collection) ? `/collections/${opts.collection}` : "";
  return `/api/${ZOTERO_PREFIX}${scope}/items?${params.toString()}`;
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
    /* Again, not only in the query string. The plain tier does not send the
       itemType filter at all, and a reply full of "PDF" and "Note" rows beside
       their parents would look like duplicated results. */
    const itemType = str(data["itemType"]);
    if (itemType === "attachment" || itemType === "note") continue;
    // A record with neither is not something a person can be shown.
    if (!key && !title) continue;
    out.push({
      key,
      itemType,
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
/**
 * A link a citation can actually resolve to, or nothing.
 *
 * The DOI first: it is the identifier a reader of the finished document needs,
 * and it is the one field in a Zotero record most likely to have been checked
 * by a person. `zotero://select/...` would open the item in Zotero and is
 * deliberately NOT used — Karen only ever opens http(s), and a marker that
 * links to a scheme the app refuses to follow is a dead link with a hover card.
 */
export function linkFor(item: LibraryItem): string {
  if (item.doi) return `https://doi.org/${item.doi.replace(/^https?:\/\/doi\.org\//i, "")}`;
  return /^https?:\/\//i.test(item.url) ? item.url : "";
}

export function formatItems(
  items: LibraryItem[],
  query: string,
  scope = "",
  /** Citation numbers, in order, for the items that have a link. */
  numbers: number[] = [],
): string {
  /* Where the search looked, said in both branches. A scoped search that finds
     nothing and an unscoped one that finds nothing are different facts, and the
     model cannot tell them apart unless the empty answer says which it was. */
  const where = scope ? `the Zotero collection ${JSON.stringify(scope)}` : "the Zotero library";
  if (items.length === 0) {
    return (
      `Nothing in ${where} matches ${JSON.stringify(query)}.` +
      (scope
        ? " Only that collection was searched, because the user chose it in the research bar; " +
          "the rest of their library was not looked at."
        : "")
    );
  }
  /* The same shape web_search prints, because that shape is what the app reads
     back to turn [n] in the model's prose into a link: a bracketed number, the
     title, then the URL on its own indented line. A library result that printed
     "1. Title" instead was information the citation machinery could not see, so
     a perfectly good Zotero record could never be cited. */
  let cited = 0;
  const lines = items.map((item) => {
    const link = linkFor(item);
    const marker = link ? `[${numbers[cited++] ?? "?"}] ` : "— ";
    const head = [
      `${marker}${item.title || "(untitled)"}`,
      [item.creators, item.year].filter(Boolean).join(" · "),
      item.publication,
      item.itemType,
    ]
      .filter(Boolean)
      .join(" — ");
    const abstract = item.abstract
      ? item.abstract.length > ABSTRACT_CHARS
        ? `${item.abstract.slice(0, ABSTRACT_CHARS).trimEnd()}…`
        : item.abstract
      : "(no abstract stored in Zotero for this item)";
    return [
      head,
      /* Indented under the title, which is the form the reader looks for. An
         item with neither DOI nor URL gets no line here and no number: it can
         still be discussed and cited by author and year, but there is nothing
         for a marker to resolve to and a marker that resolves to nothing is
         the one thing this app must never render. */
      link ? `    ${link}` : "",
      `    Zotero key ${item.key}${item.doi ? ` · DOI ${item.doi}` : ""}`,
      `    ${abstract}`,
      item.tags.length ? `    Tags: ${item.tags.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  const withAbstract = items.filter((i) => i.abstract).length;
  const unlinked = items.length - cited;
  return [
    `${items.length} item(s) from ${scope ? where : "the user's own Zotero library"}, ` +
      `${withAbstract} with an abstract stored.` +
      (scope ? " No other collection was searched." : ""),
    "",
    lines.join("\n\n"),
    unlinked
      ? `\n${unlinked} of these has no DOI or URL stored in Zotero and so carries no ` +
        "citation number. Refer to those by author and year; do not give them a number."
      : "",
  ]
    .filter((part, i) => part !== "" || i < 2)
    .join("\n");
}

export class ZoteroError extends Error {
  override readonly name = "ZoteroError";
  /** The HTTP status, when there was one. Absent means nothing answered. */
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Say what is wrong in terms of what the user would do about it.
 *
 * The two failures are indistinguishable from the reply alone and have
 * completely different fixes, so they must not share a message: nothing
 * listening on the port means Zotero is closed, and a 403 means it is running
 * with the local API switched off.
 */
export function describeFailure(status: number | undefined, body = ""): string {
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
      `Nothing answered on ${ZOTERO_HOSTS.join(" or ")} port ${ZOTERO_PORT}, so Zotero does ` +
      "not appear to be reachable. Check that Zotero is open, and that Settings → Advanced → " +
      "“Allow other applications on this computer to communicate with Zotero” is ticked. " +
      "If Zotero is running as a Flatpak or Snap, its sandbox may be keeping the port to " +
      "itself — that is the usual cause when Zotero says it is available and nothing can " +
      "reach it."
    );
  }
  /* Zotero's own words, when it had any.
   *
   * "Zotero answered 400" was the whole message, which says a request was
   * refused without saying which part of it was refused -- and left the user
   * and me guessing at a local server that had already written down the answer.
   * The body of a local API error is Zotero's own diagnostic text about a
   * request Karen composed; it carries none of the user's content. */
  const said = body.trim().replace(/\s+/g, " ").slice(0, 300);
  return `Zotero answered ${status}${said ? `: ${said}` : " with no explanation"}.`;
}
