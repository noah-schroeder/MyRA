/**
 * The papers a turn may explore: the host behind `project_papers` and
 * `read_paper`, and the "has a PDF" line `search_library` prints.
 *
 * Two shelves make up a project's papers -- the ones uploaded to it
 * ([core/sources/](../core/sources/store.ts)) and the items in its linked
 * Zotero collections -- and this is the one place that puts them together,
 * checks every ref a model names against the project it is in, and keeps the
 * keyword index built from them.
 *
 * The index is rebuilt only when what it was built from changes: the same
 * papers, each with the same text stamp, is the same index. Zotero papers are
 * indexed from the text Zotero itself already extracted (see
 * runtime/zoteroFulltext.ts), so linking a collection of three hundred papers
 * does not start three hundred pdftotext runs; reading one is what does.
 */

import { ipcMain } from "electron";

import type { ConfigStore } from "../core/config.ts";
import { collectionScope } from "../core/agent/tools/library.ts";
import type { PaperEntry, PaperHit, PapersHost } from "../core/agent/tools/papers.ts";
import { linkFor, resolveCollections, type FullTextFlags, type LibraryItem } from "../core/library/zotero.ts";
import { isItemKey } from "../core/library/zoteroFulltext.ts";
import type { Project } from "../core/projects/project.ts";
import { readResearchConfig } from "../core/research/config.ts";
import { passages, type FullText } from "../core/sources/fulltext.ts";
import { PaperIndex, type IndexedPassage } from "../core/sources/search.ts";
import { assertSourceId, SOURCE_REF, sourceLink, type Source } from "../core/sources/source.ts";
import { readSource, readSourceText } from "../core/sources/store.ts";
import { readProject } from "./projectStore.ts";
import { libraryCollections } from "./runtime/zoteroLibrary.ts";
import {
  countInCollectionsFromDb, itemsByKeysFromDb, itemsInCollectionsFromDb, keysInCollectionsFromDb,
} from "./runtime/zoteroSqlite.ts";
import { indexZoteroPdf, locatePdfs, readZoteroPdf, type Located } from "./runtime/zoteroFulltext.ts";

/** More than any real project; a shelf past it is searched in part, and the reply says so. */
const MAX_ZOTERO_PAPERS = 400;
/** How many papers the listing names before it says "and N more". */
const CATALOGUE_LINES = 60;
/** The most a single read may spend, whatever the window. */
const READ_CEILING = 3000;

export interface ProjectPapersDeps {
  config: ConfigStore;
  /** The project the turn in flight belongs to, if any. */
  turnProject: () => Project | undefined;
  /** The chat model's window, for the read budget. Unknown means the ceiling. */
  contextTokens: () => number | undefined;
}

function uploadEntry(source: Source): PaperEntry {
  return {
    ref: `${SOURCE_REF}${source.id}`,
    title: source.title,
    authors: source.authors,
    year: source.year,
    link: sourceLink(source),
    origin: "upload",
    readable: source.text === "ok",
    ...(source.text === "ok" ? {} : { why: source.textError ?? "no text could be read from it" }),
  };
}

function zoteroEntry(item: LibraryItem, located: Located | undefined): PaperEntry {
  const why = !located
    ? "no PDF is attached in Zotero"
    : located.kind === "unreadable"
      ? located.why
      : undefined;
  return {
    ref: item.key,
    title: item.title || "(untitled)",
    authors: item.creators,
    year: item.year,
    link: linkFor(item) || undefined,
    origin: "zotero",
    readable: !why,
    ...(why ? { why } : {}),
  };
}

/** What a project holds, gathered: uploads, and the Zotero items its collections list. */
async function shelf(config: ConfigStore, project: Project): Promise<{
  uploads: Source[];
  items: LibraryItem[];
  located: Map<string, Located>;
  total: number;
  note?: string;
}> {
  const uploads: Source[] = [];
  for (const m of project.members) {
    if (m.kind !== "source") continue;
    const s = await readSource(config.current.sourcesRoot, m.ref);
    if (s) uploads.push(s);
  }
  if (!project.collections?.length) return { uploads, items: [], located: new Map(), total: 0 };
  try {
    const { keys } = resolveCollections(await libraryCollections(), project.collections);
    const items = await itemsInCollectionsFromDb(keys, MAX_ZOTERO_PAPERS);
    const total = items.length < MAX_ZOTERO_PAPERS ? items.length : await countInCollectionsFromDb(keys);
    const located = await locatePdfs(items.map((i) => i.key));
    return {
      uploads,
      items,
      located,
      total,
      ...(total > items.length ? { note: `Only the ${items.length} most recently changed of ${total} Zotero items are included.` } : {}),
    };
  } catch (err) {
    /* Zotero's data folder is what full texts need, even when its API
       answers searches -- so this is said, not swallowed. */
    return {
      uploads,
      items: [],
      located: new Map(),
      total: 0,
      note: `The papers in this project's Zotero collections could not be reached: ${(err as Error).message}`,
    };
  }
}

interface Built {
  signature: string;
  index: PaperIndex;
  entries: Map<string, PaperEntry>;
  searched: number;
  skipped: PaperEntry[];
  note?: string | undefined;
}

/**
 * Module-level, not inside `installProjectPapers`'s closure: `installProjectPapers`
 * runs once at startup, so either scope holds the same one cache for the app's
 * lifetime, but only a module-level one is reachable from `dropProjectPapers`
 * below, which `myra:project-delete` calls so a deleted project's in-memory
 * SQLite index (and its open handle) does not just sit there until the app quits.
 */
const built = new Map<string, Built>();

/** Forget a project's cached index and close its SQLite handle. Safe to call on any id, built or not. */
export function dropProjectPapers(id: string): void {
  built.get(id)?.index.close();
  built.delete(id);
}

export function installProjectPapers(deps: ProjectPapersDeps): {
  host: PapersHost;
  fullTextFlags: (keys: readonly string[]) => Promise<FullTextFlags | undefined>;
} {
  const { config } = deps;

  const project = (): Project | undefined => {
    const p = deps.turnProject();
    return p && (p.members.some((m) => m.kind === "source") || p.collections?.length) ? p : undefined;
  };

  /** Texts for every paper, then the index -- rebuilt only when a text stamp changed. */
  async function indexFor(p: Project): Promise<Built> {
    const { uploads, items, located, note } = await shelf(config, p);
    const texts: { entry: PaperEntry; text: FullText; stamp: string }[] = [];
    const skipped: PaperEntry[] = [];
    for (const s of uploads) {
      const entry = uploadEntry(s);
      const text = s.text === "ok" ? await readSourceText(config.current.sourcesRoot, s.id) : undefined;
      if (text) texts.push({ entry, text, stamp: s.sha256 });
      else skipped.push(entry);
    }
    for (const item of items) {
      const loc = located.get(item.key);
      const entry = zoteroEntry(item, loc);
      if (!loc || loc.kind === "unreadable") {
        skipped.push(entry);
        continue;
      }
      const got = await indexZoteroPdf(loc);
      if ("text" in got) texts.push({ entry, text: got.text, stamp: got.stamp });
      else skipped.push({ ...entry, readable: false, why: got.error });
    }

    const signature = texts.map((t) => `${t.entry.ref}=${t.stamp}`).sort().join("|");
    const previous = built.get(p.id);
    if (previous && previous.signature === signature) {
      return { ...previous, skipped, note };
    }
    previous?.index.close();
    const rows: IndexedPassage[] = [];
    for (const t of texts) {
      for (const passage of passages(t.text)) {
        rows.push({ ...passage, paper: t.entry.ref, page: t.text.paged ? passage.page : 0 });
      }
    }
    const next: Built = {
      signature,
      index: new PaperIndex(rows),
      entries: new Map(texts.map((t) => [t.entry.ref, t.entry])),
      searched: texts.length,
      skipped,
      note,
    };
    built.set(p.id, next);
    return next;
  }

  /** Whether a Zotero key is one this turn may open: in the project's collections, or in the bar's scope outside one. */
  async function zoteroAllowed(key: string, p: Project | undefined): Promise<string | undefined> {
    if (p?.collections?.length) {
      const { keys } = resolveCollections(await libraryCollections(), p.collections);
      return (await keysInCollectionsFromDb(keys)).has(key)
        ? undefined
        : "it is not in the Zotero collections linked to this project";
    }
    const chosen = collectionScope(readResearchConfig());
    if (chosen) {
      const { keys } = resolveCollections(await libraryCollections(), [{ key: chosen, name: chosen }]);
      return (await keysInCollectionsFromDb(keys)).has(key)
        ? undefined
        : "it is not in the Zotero collection the search was limited to";
    }
    return undefined;
  }

  const host: PapersHost = {
    scope: () => {
      const p = project();
      /* outsideProject is specifically "no project" -- see PapersHost's own
         doc comment -- so it must not also be true once `p` is set, or a
         future canRead()/consumer that trusts the name over the ladder's own
         cumulative ordering would grant a Library-rung read inside a project
         a Library-only mode was never meant to reach. */
      return p ? { project: p.name } : { outsideProject: true };
    },

    catalogue: async () => {
      const p = project();
      if (!p) return { entries: [], more: 0 };
      const { uploads, items, located, total } = await shelf(config, p);
      const entries = [...uploads.map(uploadEntry), ...items.map((i) => zoteroEntry(i, located.get(i.key)))];
      const shown = entries.slice(0, CATALOGUE_LINES);
      return { entries: shown, more: entries.length - shown.length + Math.max(0, total - items.length) };
    },

    search: async (query, limit) => {
      const p = project();
      if (!p) return { hits: [], searched: 0, skipped: [] };
      const b = await indexFor(p);
      const hits: PaperHit[] = b.index.search(query, { limit }).flatMap((h) => {
        const paper = b.entries.get(h.paper);
        return paper ? [{ paper, page: h.page, section: h.section, text: h.text }] : [];
      });
      const skipped = b.note ? [...b.skipped, { ref: "", title: "Zotero", authors: "", year: "", origin: "zotero" as const, readable: false, why: b.note }] : b.skipped;
      return { hits, searched: b.searched, skipped };
    },

    read: async (ref) => {
      const p = deps.turnProject();
      const unknown = (why: string): Awaited<ReturnType<PapersHost["read"]>> => ({
        paper: { ref, title: ref, authors: "", year: "", origin: "zotero", readable: false, why },
        error: why,
      });

      if (ref.startsWith(SOURCE_REF)) {
        let id: string;
        try {
          id = assertSourceId(ref.slice(SOURCE_REF.length));
        } catch {
          return unknown("that is not a paper id");
        }
        /* Only this project's own uploads. An id is a filename on disk, and a
           model that learned one in another project must not open it here. */
        const fresh = p ? await readProject(p.id) : undefined;
        if (!fresh?.members.some((m) => m.kind === "source" && m.ref === id)) {
          return unknown("it is not a paper in this conversation's project");
        }
        const source = await readSource(config.current.sourcesRoot, id);
        if (!source) return unknown("it is no longer there");
        const text = source.text === "ok" ? await readSourceText(config.current.sourcesRoot, id) : undefined;
        return { paper: uploadEntry(source), text, ...(text ? {} : { error: source.textError ?? "no text could be read from it" }) };
      }

      const key = ref.toUpperCase();
      if (!isItemKey(key)) return unknown("that is neither a paper id nor a Zotero key");
      try {
        const refused = await zoteroAllowed(key, project());
        if (refused) return unknown(refused);
        const [item] = await itemsByKeysFromDb([key]);
        if (!item) return unknown("Zotero has no item with that key");
        const loc = (await locatePdfs([key])).get(key);
        const paper = zoteroEntry(item, loc);
        if (!loc || loc.kind === "unreadable") return { paper, error: paper.why };
        const got = await readZoteroPdf(loc);
        return "text" in got ? { paper, text: got.text } : { paper, error: got.error };
      } catch (err) {
        return unknown((err as Error).message);
      }
    },

    budget: () => {
      const window = deps.contextTokens();
      return window && window > 0 ? Math.min(READ_CEILING, Math.floor(window / 6)) : READ_CEILING;
    },
  };

  const fullTextFlags = async (keys: readonly string[]): Promise<FullTextFlags | undefined> => {
    try {
      const located = await locatePdfs(keys);
      return new Map(keys.map((k) => {
        const loc = located.get(k);
        return [k, loc && loc.kind !== "unreadable" ? "readable" : "none"] as const;
      }));
    } catch {
      /* No data folder to look in: say nothing per item rather than "none". */
      return undefined;
    }
  };

  /* For the project page: how much of its Zotero shelf can actually be read. */
  ipcMain.handle("myra:project-papers-status", async (_e, id: unknown) => {
    const p = await readProject(String(id ?? ""));
    if (!p) return { ok: false, error: "That project could not be read." };
    if (!p.collections?.length) return { ok: true };
    const { items, located, note } = await shelf(config, p);
    if (note && !items.length) return { ok: false, error: note };
    const readable = items.filter((i) => {
      const loc = located.get(i.key);
      return loc && loc.kind !== "unreadable";
    }).length;
    /* `items.length`, not the collection's true total: past MAX_ZOTERO_PAPERS
       only the most-recently-changed items are ever fetched and checked for a
       readable PDF, so counting the ratio against the uncapped total silently
       understated readability -- everything beyond the cap counted against the
       denominator without ever having been examined. */
    return { ok: true, zotero: { items: items.length, readable } };
  });

  return { host, fullTextFlags };
}
