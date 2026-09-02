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

import { readResearchConfig, readsLibrary } from "../../research/config.ts";
import { formatItems, type LibraryItem, type SearchMode } from "../../library/zotero.ts";
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
  search(opts: { query: string; limit?: number; mode?: SearchMode }): Promise<LibraryItem[]>;
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

export const searchLibraryTool: ToolDef = {
  name: "search_library",
  description:
    "Search the user's own Zotero library — the papers they have already collected — by " +
    "keyword, author or subject. Searches titles, abstracts, tags, notes and the indexed " +
    "text of attached PDFs. Returns each item's authors, year, DOI and abstract. This is " +
    "the user's personal collection, not the wider literature; it runs entirely on this " +
    "machine and reaches no network.",
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

    const items = await host.search({
      query,
      mode,
      ...(Number.isFinite(rawLimit) && rawLimit >= 1 ? { limit: rawLimit } : {}),
    });

    return {
      content: formatItems(items, query),
      detail: { count: items.length, keys: items.map((i) => i.key) },
    };
  },
};

export const LIBRARY_TOOL_DEFS: ToolDef[] = [searchLibraryTool];
