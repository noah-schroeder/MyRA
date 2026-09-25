/**
 * Searching the user's own Zotero library.
 *
 * Its own rung on the ladder, below the two that reach the network. That
 * placement is the whole design: Zotero's local API is loopback with no key, so
 * a library search reaches no further than reading a file does — which means
 * the researcher who keeps searching switched off for privacy is exactly the
 * person who can still have their own papers searchable.
 *
 * It began gated with the documents, which was defensible and wrong in
 * practice: reachable, but with nothing on screen saying so, which a user
 * cannot tell apart from the feature not existing. A rung is a control, and a
 * control is the difference.
 */

import {
  exactly, readResearchConfig, readsLibrary, type ResearchConfig,
} from "../../research/config.ts";
import {
  descendantKeys, formatItems, linkFor, MAX_FANOUT, resolveCollections,
  type FullTextFlags, type LibraryItem, type ScopeWording, type SearchMode, type ZoteroCollection,
} from "../../library/zotero.ts";
import { DATABASE_ROUTE_NOTE } from "../../library/zoteroDb.ts";
import { cite } from "../../research/ledger.ts";
import type { ToolDef } from "../registry.ts";

/**
 * What the app must attach: a way to reach Zotero.
 *
 * The HTTP call itself lives in the main process, like every other network
 * client in this app. Left uninstalled the tool REFUSES rather than pretending
 * the library is empty — "nothing matched" and "nothing was asked" are
 * different answers, and only one of them is honest.
 */
export interface LibraryHost {
  search(opts: {
    query: string;
    limit?: number;
    mode?: SearchMode;
    /** The collection subtree to search inside. All of it, when absent. */
    collections?: string[];
  }): Promise<LibraryItem[]>;
  /** Every collection in the library, flat; the subtree is resolved from it. */
  collections(): Promise<ZoteroCollection[]>;
  /**
   * How the last read was served.
   *
   * Absent means the API, which is what a host that knows of only one way in
   * can be. It matters to the reply because the two routes do not search the
   * same thing: reading the database file cannot reach the text inside PDFs,
   * and an answer that did not say so would let a thinner search pass for the
   * wider one.
   */
  route?(): "api" | "database";
  /**
   * The project this turn's conversation belongs to, when it has Zotero
   * collections linked -- set by main per turn, the way the `remember` tool's
   * host is. Absent outside a project, or in one with none linked.
   */
  projectScope?(): ProjectLibraryScope | undefined;
  /** Which of these items have a PDF MyRA can read. Absent when that cannot be checked at all. */
  fullTextFlags?(keys: readonly string[]): Promise<FullTextFlags | undefined>;
}

export interface ProjectLibraryScope {
  /** The project's name, for a reply that has to say why the search was narrowed. */
  name: string;
  collections: { key: string; name: string }[];
}

let host: LibraryHost | undefined;

export function setLibraryHost(installed: LibraryHost | undefined): void {
  host = installed;
}

/**
 * The library rung and everything above it.
 *
 * Its own rung rather than riding along with the documents, because the point
 * of a control is that you can see what it does: the tool was reachable at the
 * document rung and nothing on screen said so, which is indistinguishable from
 * it not existing. Choosing "Library" is now how you turn it on, and the two
 * searching rungs keep it, so moving up never takes it away.
 */
function available(): boolean {
  return readsLibrary(readResearchConfig().mode);
}

/**
 * The collection scope, but only at the rung that shows the control.
 *
 * The picker sits under "Library" and nowhere else, because Quick and Deep are
 * questions about the literature and a Zotero collection picker beneath them
 * reads as though the two were one feature. Once the control is gone, the
 * setting has to go with it: a scope still narrowing results at a rung with
 * nothing on screen to see or change it is the "reachable, and nothing says so"
 * failure the library rung was created to fix, in miniature.
 *
 * So above Library the whole library is searched. That is the wider answer,
 * which cannot be mistaken for a narrower one, and the reply says which it was
 * either way.
 */
export function collectionScope(cfg: ResearchConfig): string | undefined {
  return exactly(cfg.mode, "library") ? cfg.collection : undefined;
}

export const searchLibraryTool: ToolDef = {
  name: "search_library",
  description:
    "Search the user's own Zotero library — the papers they have already collected — by " +
    "keyword, author or subject. Searches titles, abstracts, tags, notes and the indexed " +
    "text of attached PDFs. Returns each item's authors, year, DOI and abstract. This is " +
    "the user's personal collection, not the wider literature; it runs entirely on this " +
    "machine and reaches no network. The user may have limited the search to some of their " +
    "Zotero collections -- in the research bar, or by linking them to this conversation's " +
    "project; the result says which, and that limit cannot be widened from here.",
  risk: "safe",
  enabled: available,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keywords, an author's name, or a subject" },
      limit: { type: "number", description: "How many items to return (default 25, max 100)" },
      mode: {
        type: "string",
        description:
          "\"everything\" (default) also searches notes and PDF text; " +
          "\"titleCreatorYear\" restricts to titles, authors and years when a common " +
          "word matches too much.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  /**
   * Which collection to search, resolved against the library as it is NOW.
   *
   * The scope is a stored key, and Zotero is another program: the collection
   * can be renamed, moved or deleted between the choice and the search. So the
   * name is taken from Zotero rather than from the setting, and a key that is
   * no longer there is an error rather than a request Zotero would answer with
   * a 404 that reads like the library being unreachable.
   *
   * Not overridable by the model, for the same reason `effectiveCategory` is
   * not: a scope the model could widen at will would not be a scope.
   */
  async handler(params) {
    if (!host) {
      throw new Error(
        "The Zotero library is not available: the app has not attached a library host. " +
          "This is a wiring fault, not something to work around.",
      );
    }
    const query = String(params["query"] ?? "").trim();
    if (!query) throw new Error("search_library was given no query");

    const rawMode = String(params["mode"] ?? "everything");
    const mode: SearchMode = rawMode === "titleCreatorYear" ? "titleCreatorYear" : "everything";
    const rawLimit = Number(params["limit"]);

    const chosen = collectionScope(readResearchConfig());
    const project = host.projectScope?.();
    let collections: string[] = [];
    let scope = "";
    let truncated = false;
    let wording: ScopeWording | undefined;
    const notes: string[] = [];
    if (project?.collections.length) {
      /* A project's own collections win over the bar's, at every rung this
         tool runs at: the person linked them to THIS work, and the reply says
         so, so the model can pass on that the rest of the library was not
         searched. */
      const r = resolveCollections(await host.collections(), project.collections);
      if (!r.keys.length) {
        throw new Error(
          `None of the Zotero collections linked to the project “${project.name}” is still in the library ` +
            `(${project.collections.map((c) => c.name).join(", ")}) — they have probably been deleted or ` +
            "are in a different Zotero profile. Link others from the project's page.",
        );
      }
      collections = r.keys;
      truncated = r.truncated;
      const names = r.found.map((c) => c.name);
      scope = names.join(", ");
      const below = r.keys.length - r.found.length;
      wording = {
        where:
          `the Zotero collection${names.length === 1 ? "" : "s"} linked to this project (${names.join(", ")}` +
          `${below > 0 ? `, and ${below} below ${names.length === 1 ? "it" : "them"}` : ""})`,
        why: "because the user linked them to this project",
      };
      if (r.missing.length) {
        notes.push(
          `Not searched, because Zotero no longer has ${r.missing.length === 1 ? "it" : "them"}: ` +
            `${r.missing.map((m) => `“${m.name}”`).join(", ")}. Mention this if it matters to the answer.`,
        );
      }
    } else if (chosen) {
      const all = await host.collections();
      const found = all.find((c) => c.key === chosen);
      if (!found) {
        throw new Error(
          "The Zotero collection this search was limited to is no longer in the library — " +
            "it has probably been deleted or is in a different Zotero profile. Choose another " +
            "collection, or “All collections”, next to the Library button.",
        );
      }
      collections = descendantKeys(all, chosen);
      truncated = collections.length >= MAX_FANOUT;
      scope =
        collections.length > 1
          ? `${found.name} (and ${collections.length - 1} collection(s) below it)`
          : found.name;
    }

    const items = await host.search({
      query,
      mode,
      ...(collections.length ? { collections } : {}),
      ...(Number.isFinite(rawLimit) && rawLimit >= 1 ? { limit: rawLimit } : {}),
    });

    /* Numbered from the same ledger web_search draws on, because at the Quick
       and Deep rungs both tools are in the schema at once and two independent
       numberings would put two different papers behind one marker. Keyed by
       link, so a paper the user has in Zotero AND that a web search returns
       keeps one number across both. */
    const links = items.map(linkFor).filter(Boolean);
    if (truncated) {
      notes.push(
        `Only the first ${MAX_FANOUT} collections of that subtree were searched; it has ` +
          "more. Say so if the answer looks incomplete.",
      );
    }
    if (host.route?.() === "database") notes.push(DATABASE_ROUTE_NOTE);
    const fullText = await host.fullTextFlags?.(items.map((i) => i.key)).catch(() => undefined);
    const content = formatItems(items, query, scope, cite(links), { wording, fullText });
    return {
      content: notes.length ? `${content}\n\n${notes.join("\n\n")}` : content,
      detail: { count: items.length, keys: items.map((i) => i.key), ...(scope ? { scope } : {}) },
    };
  },
};

export const LIBRARY_TOOL_DEFS: ToolDef[] = [searchLibraryTool];
