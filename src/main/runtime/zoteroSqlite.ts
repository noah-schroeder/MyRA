/**
 * The second way into a Zotero library: its own file.
 *
 * Used only when the local API does not answer at all. It exists because a
 * sandboxed Zotero -- Flatpak or Snap -- keeps its port inside its own network
 * namespace, so the API is running, advertised in Zotero's settings pane, and
 * unreachable from any other process on the machine. The data directory is not
 * hidden in the same way: a Flatpak's lives under ~/.var/app on the ordinary
 * filesystem.
 *
 * Everything here is read-only, twice over: the connection is opened read-only,
 * and it is opened on a snapshot rather than on the user's live database. That
 * is not caution for its own sake. Zotero keeps zotero.sqlite open in WAL mode
 * the whole time it runs, and a research library is often the least replaceable
 * file a person owns.
 */

import { backup, DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { CONFIG_DIR, OWNER_ONLY_DIR } from "../../core/paths.ts";

import {
  BATCH, chunk, collectionCountSql, COLLECTIONS_SQL, creatorsSql, dataDirCandidates, fieldsSql,
  inCollectionsSql, likeParam, matchSql, rowsSql, SCAN_BUDGET, searchRoots, searchTerms, shapeItem,
  SKIP_DIRS, tagsSql, ZOTERO_DB, type ItemParts,
} from "../../core/library/zoteroDb.ts";
import { ZoteroError, type LibraryItem, type SearchMode, type ZoteroCollection } from "../../core/library/zotero.ts";

/**
 * Where a snapshot is kept: real disk, beside Karen's other state.
 *
 * Not the system temp directory. On most Linux desktops /tmp is a tmpfs, so a
 * two-gigabyte library snapshotted there is two gigabytes of RAM per search --
 * and the libraries big enough for that are the ones a researcher actually has.
 */
function snapshotDir(): string {
  return join(CONFIG_DIR, "zotero-snapshot");
}

/**
 * The data directory, if one of the usual places has a library in it.
 *
 * `KAREN_ZOTERO_DIR` wins, for a library kept somewhere else entirely -- Zotero
 * lets the user move it, and guessing is not going to find it.
 */
export function findZoteroDataDir(): string | undefined {
  const named = process.env["KAREN_ZOTERO_DIR"];
  const candidates = named
    ? [named]
    : dataDirCandidates(process.env["HOME"] ?? homedir());
  for (const dir of candidates) {
    try {
      if (statSync(join(dir, ZOTERO_DB)).isFile()) return dir;
    } catch {
      // Not there. The next candidate, or none.
    }
  }
  /* Named explicitly and wrong is not the same as not named: if the user set
     the variable, that is the answer, and searching elsewhere would quietly
     read a library they did not point at. */
  return named ? undefined : scanForLibrary();
}

/**
 * A bounded look inside the sandbox homes for a library the guesses missed.
 *
 * Breadth-first with a budget, skipping the directories that cannot hold the
 * database and can hold thousands of entries. This is cheap because both roots
 * are small and shallow; it exists because being one directory wrong leaves the
 * user exactly as stuck as having no fallback at all.
 */
function scanForLibrary(): string | undefined {
  const queue = searchRoots(process.env["HOME"] ?? homedir());
  let budget = SCAN_BUDGET;
  while (queue.length && budget-- > 0) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => e.isFile() && e.name === ZOTERO_DB)) return dir;
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
        queue.push(join(dir, entry.name));
      }
    }
  }
  return undefined;
}

/**
 * What a snapshot was taken from, so it can be reused until it goes stale.
 *
 * Copying a multi-gigabyte library on every search would make the fallback
 * unusable on exactly the libraries that need it most. The stamp is the source
 * file's size and modification time, plus the write-ahead log's -- Zotero
 * writes there first, so a -wal that has changed means the snapshot is behind
 * even when zotero.sqlite itself looks untouched.
 */
let taken: { path: string; stamp: string } | undefined;

function stampOf(dataDir: string): string {
  const parts: string[] = [];
  for (const name of [ZOTERO_DB, `${ZOTERO_DB}-wal`]) {
    try {
      const s = statSync(join(dataDir, name));
      parts.push(`${name}:${s.size}:${s.mtimeMs}`);
    } catch {
      parts.push(`${name}:absent`);
    }
  }
  return parts.join("|");
}

async function snapshot(dataDir: string): Promise<string> {
  const stamp = stampOf(dataDir);
  if (taken && taken.stamp === stamp && existsSync(taken.path)) return taken.path;

  const dir = snapshotDir();
  mkdirSync(dir, { recursive: true, mode: OWNER_ONLY_DIR });
  const path = join(dir, ZOTERO_DB);
  /* The old one goes before the new one is written: a half-written snapshot
     that still had the previous file's name would be opened as if it were
     whole. */
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${path}${suffix}`);
    } catch {
      // Nothing there, which is the normal case.
    }
  }

  /* Opened read-only, then copied by SQLite itself rather than by us. The
     backup API holds a read transaction and starts over if Zotero writes
     underneath it, so the result is a consistent point in time; a file copy of
     a live WAL database is not, and produces torn pages under the ordinary
     case of Zotero syncing while you search. */
  const source = openSource(dataDir);
  if (source) {
    try {
      await backup(source, path);
    } finally {
      source.close();
    }
    taken = { path, stamp };
    return path;
  }

  /*
   * The one case backup cannot serve: the source will not open at all.
   *
   * Opening a WAL database, even read-only, needs the shared-memory file
   * beside it -- so a library on a read-only mount, or restored from a backup,
   * refuses every connection. Copying is second best because a copy of a
   * database being written to can be torn, but a Zotero that cannot be opened
   * is a Zotero that is not running, and one that is not running is not
   * writing.
   *
   * The -wal and -shm files must come too. Without them, content that has not
   * been checkpointed yet is simply absent, and the copy opens as an empty
   * library rather than as an error -- the worst of both.
   */
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = join(dataDir, `${ZOTERO_DB}${suffix}`);
    if (existsSync(from)) copyFileSync(from, `${path}${suffix}`);
  }
  taken = { path, stamp };
  return path;
}

function openSource(dataDir: string): DatabaseSync | undefined {
  try {
    return new DatabaseSync(join(dataDir, ZOTERO_DB), { readOnly: true });
  } catch {
    return undefined;
  }
}

/** Nothing outlives the app: the snapshot is a copy of somebody's library. */
export function forgetZoteroSnapshot(): void {
  const dir = snapshotDir();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort. A snapshot left behind is readable only by this user.
  }
  taken = undefined;
}

async function open(): Promise<{ db: DatabaseSync; dataDir: string }> {
  const dataDir = findZoteroDataDir();
  if (!dataDir) {
    throw new ZoteroError(
      "Zotero's local API did not answer, and Karen could not find a Zotero data directory to " +
        "read instead. It looked in " +
        dataDirCandidates("~").join(", ") +
        ". If your library is somewhere else, start Karen with KAREN_ZOTERO_DIR set to that " +
        "folder — the one containing zotero.sqlite.",
    );
  }
  try {
    const path = await snapshot(dataDir);
    return { db: new DatabaseSync(path, { readOnly: true }), dataDir };
  } catch (err) {
    throw new ZoteroError(
      `Zotero's local API did not answer, and its database at ${join(dataDir, ZOTERO_DB)} could ` +
        `not be read either: ${(err as Error).message}`,
    );
  }
}

export async function collectionsFromDb(): Promise<ZoteroCollection[]> {
  const { db } = await open();
  try {
    const rows = db.prepare(COLLECTIONS_SQL).all() as { key: unknown; name: unknown; parent: unknown }[];
    const out: ZoteroCollection[] = [];
    for (const row of rows) {
      const key = typeof row.key === "string" ? row.key : "";
      const name = typeof row.name === "string" ? row.name.trim() : "";
      if (!key || !name) continue;
      out.push(typeof row.parent === "string" ? { key, name, parent: row.parent } : { key, name });
    }
    return out;
  } finally {
    db.close();
  }
}

/** Ids matching every term, which is what Zotero's own quick search means. */
function idsForTerms(db: DatabaseSync, query: string, mode: SearchMode): Set<number> {
  const terms = searchTerms(query);
  let matched: Set<number> | undefined;
  const statement = db.prepare(matchSql(mode));
  for (const term of terms) {
    const rows = statement.all({ like: likeParam(term) }) as { itemID: unknown }[];
    const here = new Set<number>();
    for (const row of rows) if (typeof row.itemID === "number") here.add(row.itemID);
    matched = matched === undefined ? here : new Set([...matched].filter((id) => here.has(id)));
    if (matched.size === 0) break;
  }
  return matched ?? new Set<number>();
}

function idsInCollections(db: DatabaseSync, keys: string[]): Set<number> {
  const found = new Set<number>();
  for (const part of chunk(keys)) {
    const rows = db.prepare(inCollectionsSql(part)).all(...part) as { itemID: unknown }[];
    for (const row of rows) if (typeof row.itemID === "number") found.add(row.itemID);
  }
  return found;
}

/** One column of strings per item, from a query that returns many rows each. */
function gather<T>(
  db: DatabaseSync,
  sql: (ids: number[]) => string,
  ids: number[],
  add: (into: Map<number, T>, row: Record<string, unknown>) => void,
): Map<number, T> {
  const out = new Map<number, T>();
  for (const part of chunk(ids)) {
    for (const row of db.prepare(sql(part)).all(...part) as Record<string, unknown>[]) {
      add(out, row);
    }
  }
  return out;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

export async function searchDb(opts: {
  query: string;
  limit?: number;
  mode?: SearchMode;
  collections?: string[];
}): Promise<LibraryItem[]> {
  const { db } = await open();
  try {
    let ids = idsForTerms(db, opts.query, opts.mode ?? "everything");
    if (opts.collections?.length) {
      const scoped = idsInCollections(db, opts.collections);
      ids = new Set([...ids].filter((id) => scoped.has(id)));
    }
    if (ids.size === 0) return [];

    /* Sorted here rather than by the database, because the candidates are read
       in batches and each batch would otherwise be ordered only within itself.
       `dateModified` descending is what the API route asks for, so the two
       agree on which paper is at the top. */
    type Row = { itemID: number; key: string; itemType: string; dateModified: string };
    const rows: Row[] = [];
    for (const part of chunk([...ids])) {
      for (const row of db.prepare(rowsSql(part)).all(...part) as Record<string, unknown>[]) {
        if (typeof row["itemID"] !== "number") continue;
        rows.push({
          itemID: row["itemID"],
          key: text(row["key"]),
          itemType: text(row["itemType"]),
          dateModified: text(row["dateModified"]),
        });
      }
    }
    rows.sort((a, b) => b.dateModified.localeCompare(a.dateModified));

    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 25), 1), 100);
    const wanted = rows.slice(0, limit);
    const chosen = wanted.map((r) => r.itemID);
    if (chosen.length === 0) return [];

    const fields = gather<Record<string, string>>(db, fieldsSql, chosen, (into, row) => {
      const id = row["itemID"] as number;
      const bag = into.get(id) ?? {};
      bag[text(row["fieldName"])] = text(row["value"]);
      into.set(id, bag);
    });
    const creators = gather<ItemParts["creators"]>(db, creatorsSql, chosen, (into, row) => {
      const id = row["itemID"] as number;
      const list = into.get(id) ?? [];
      list.push({
        firstName: text(row["firstName"]),
        lastName: text(row["lastName"]),
        fieldMode: typeof row["fieldMode"] === "number" ? row["fieldMode"] : 0,
      });
      into.set(id, list);
    });
    const tags = gather<string[]>(db, tagsSql, chosen, (into, row) => {
      const id = row["itemID"] as number;
      const list = into.get(id) ?? [];
      const name = text(row["name"]).trim();
      if (name) list.push(name);
      into.set(id, list);
    });
    const counts = gather<number>(db, collectionCountSql, chosen, (into, row) => {
      const id = row["itemID"] as number;
      into.set(id, typeof row["n"] === "number" ? row["n"] : 0);
    });

    return wanted.map((row) =>
      shapeItem({
        key: row.key,
        itemType: row.itemType,
        fields: fields.get(row.itemID) ?? {},
        creators: creators.get(row.itemID) ?? [],
        tags: tags.get(row.itemID) ?? [],
        collections: counts.get(row.itemID) ?? 0,
      }),
    );
  } finally {
    db.close();
  }
}

/** Exported for the tests, which need the batch size to exceed it on purpose. */
export const SQLITE_BATCH = BATCH;
