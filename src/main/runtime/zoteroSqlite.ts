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
import {
  accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { CONFIG_DIR, OWNER_ONLY_DIR } from "../../core/paths.ts";

import {
  BATCH, chunk, collectionCountSql, COLLECTIONS_SQL, creatorsSql, dataDirCandidates, fieldsSql,
  inCollectionsSql, ITEM_COUNT_SQL, likeParam, matchSql, rowsSql, SCAN_BUDGET, searchRoots,
  searchTerms, shapeItem, SKIP_DIRS, tagsSql, ZOTERO_DB, type ItemParts,
} from "../../core/library/zoteroDb.ts";
import {
  dataDirFromPrefs, looksLikeProfileDir, parseProfilesIni, PREFS_FILE, PROFILES_INI, profileRoots,
} from "../../core/library/zoteroProfile.ts";
import { ZoteroError, type LibraryItem, type SearchMode, type ZoteroCollection } from "../../core/library/zotero.ts";

/**
 * Where a snapshot is kept: real disk, beside MyRA's other state.
 *
 * Not the system temp directory. On most Linux desktops /tmp is a tmpfs, so a
 * two-gigabyte library snapshotted there is two gigabytes of RAM per search --
 * and the libraries big enough for that are the ones a researcher actually has.
 */
function snapshotDir(): string {
  return join(CONFIG_DIR, "zotero-snapshot");
}

/**
 * The folder the user named in Settings, if they named one.
 *
 * Held here rather than read from the config store, because this module is on
 * the path of every library search and must not acquire a dependency on
 * settings loading first. The main process sets it at startup and on every
 * change, which is the same lifetime the setting has.
 */
let chosenDir = "";

export function setZoteroDataDir(dir: string | undefined): void {
  chosenDir = (dir ?? "").trim();
}

/** Where a data directory came from, so the user can be told which. */
export type DirSource = "setting" | "environment" | "profile" | "default" | "search";

export interface DirFinding {
  path?: string;
  source?: DirSource;
  /** Every directory checked, in order, for a report that can be acted on. */
  tried: string[];
  /** Profiles read, and what each said. Empty when Zotero has never run here. */
  profiles: { path: string; dataDir?: string }[];
}

function hasLibrary(dir: string): boolean {
  try {
    return statSync(join(dir, ZOTERO_DB)).isFile();
  } catch {
    return false;
  }
}

/**
 * The data directory, and how it was arrived at.
 *
 * Five ways, in descending order of how much they are worth trusting:
 *
 *   1. What the user typed in Settings. Nothing overrules a person saying
 *      where their own library is.
 *   2. MYRA_ZOTERO_DIR, the same answer from a launcher or a script.
 *   3. Zotero's own `extensions.zotero.dataDir`, read from its profile. This
 *      is not a guess -- it is the value Zotero itself opens on startup -- and
 *      it is the only thing that finds a library somebody moved to another
 *      disk, which is what a researcher with a large library does.
 *   4. The default locations, including the sandboxed ones.
 *   5. A bounded search of the sandbox homes, for a layout none of the above
 *      predicted.
 *
 * The first two are exclusive on purpose: told explicitly where the library
 * is, MyRA does not go looking somewhere else and quietly read a different
 * one. It reports that the named folder holds no library, which is a fact the
 * user can act on.
 */
export function locateZoteroDataDir(): DirFinding {
  const tried: string[] = [];
  const profiles: { path: string; dataDir?: string }[] = [];

  for (const [dir, source] of [
    [chosenDir, "setting"],
    [process.env["MYRA_ZOTERO_DIR"] ?? "", "environment"],
  ] as const) {
    if (!dir) continue;
    tried.push(dir);
    return hasLibrary(dir) ? { path: dir, source, tried, profiles } : { tried, profiles };
  }

  const home = process.env["HOME"] ?? homedir();

  /* Zotero's own answer first, because it is the only one that can be right
     about a library that is not in any of the usual places. */
  for (const prefs of readProfiles(home, profiles)) {
    tried.push(prefs);
    if (hasLibrary(prefs)) return { path: prefs, source: "profile", tried, profiles };
  }

  for (const dir of dataDirCandidates(home)) {
    tried.push(dir);
    if (hasLibrary(dir)) return { path: dir, source: "default", tried, profiles };
  }

  const found = scanForLibrary();
  return found ? { path: found, source: "search", tried, profiles } : { tried, profiles };
}

export function findZoteroDataDir(): string | undefined {
  return locateZoteroDataDir().path;
}

/**
 * Every data directory Zotero's own profiles name, most-default first.
 *
 * Records what each profile said as it goes, including the profiles that said
 * nothing: "Zotero is here and using its default location" and "Zotero has
 * never run on this machine" look identical from the outside and need
 * different advice.
 */
function readProfiles(home: string, into: { path: string; dataDir?: string }[]): string[] {
  const out: string[] = [];
  for (const root of profileRoots(home, process.env)) {
    for (const dir of profileDirs(root)) {
      let dataDir: string | undefined;
      try {
        dataDir = dataDirFromPrefs(readFileSync(join(dir, PREFS_FILE), "utf8"));
      } catch {
        // No prefs.js in it, or unreadable: not a profile MyRA can learn from.
        continue;
      }
      into.push(dataDir ? { path: dir, dataDir } : { path: dir });
      if (dataDir) out.push(dataDir);
    }
  }
  return out;
}

/** The profile folders under one root: what the ini says, else the usual names. */
function profileDirs(root: string): string[] {
  const found: string[] = [];
  try {
    found.push(...parseProfilesIni(readFileSync(join(root, PROFILES_INI), "utf8"), root));
  } catch {
    // No ini, or unreadable. The conventional names below still apply.
  }
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && looksLikeProfileDir(entry.name)) found.push(join(root, entry.name));
    }
  } catch {
    // No such root, which is the normal case for every platform but one.
  }
  return [...new Set(found)];
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
      taken = { path, stamp };
      return path;
    } catch {
      /*
       * Backup is the better read, not the only one.
       *
       * It can fail on a library that opens perfectly well -- reported from a
       * running Zotero, with SQLite raising an error whose code was never set
       * ("not an error"). Giving up there loses the file route entirely on the
       * install that has the file, so the copy below is tried instead. It is
       * second best and the header says why; it is not second best to nothing.
       */
    } finally {
      source.close();
    }
  }

  /*
   * The cases backup cannot serve: the source will not open at all, or it
   * opened and the backup itself failed.
   *
   * Opening a WAL database, even read-only, needs the shared-memory file
   * beside it -- so a library on a read-only mount, or restored from a backup,
   * refuses every connection. Copying is second best because a copy of a
   * database being written to can be torn; against that, a WAL frame is
   * checksummed, so recovery stops at the first torn one and yields a slightly
   * older library rather than a wrong one.
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

/**
 * What to say when there is no library file to read either.
 *
 * Written from what was actually looked at rather than from a fixed list,
 * because the two cases need opposite advice: a Zotero whose profile MyRA
 * read and whose folder simply is not there has moved, and a machine with no
 * profile at all has no Zotero on it. Both end with the one thing the user can
 * do about it, which is a folder picker in Settings and not an environment
 * variable they would have to relaunch the app to set.
 */
export function noLibraryHere(found: DirFinding, opts: { paths?: boolean } = {}): string {
  const named = found.tried.length === 1 && (found.source === undefined) && !found.profiles.length;
  const head = named
    ? `There is no ${ZOTERO_DB} in ${found.tried[0]}.`
    : found.profiles.length
      ? "Zotero has run on this machine, but MyRA could not find its library file."
      : "MyRA could not find a Zotero library on this machine, and found no Zotero profile either.";
  const said = found.profiles
    .filter((p) => p.dataDir)
    .map((p) => p.dataDir!)
    .join(", ");
  /* The panel in Settings lists every path it tried, right underneath this
     message, so repeating them here turns a two-line diagnosis into a wall of
     absolute paths and buries the sentence that says what to do. The tool's
     error has no such list, and names the first few. */
  const rest = found.tried.length - 3;
  return [
    "Zotero's local API did not answer, so MyRA tried to read the library file instead. " + head,
    said ? `Zotero's own settings say the library is in ${said}, and it is not there now.` : "",
    opts.paths
      ? `It looked in: ${found.tried.slice(0, 3).join(", ")}${rest > 0 ? `, and ${rest} more` : ""}.`
      : "",
    opts.paths
      ? "If your library is somewhere else — a second disk, or a synced folder — set it in " +
        "Settings → Library, where there is a folder picker and a check that says what it found."
      : "If your library is somewhere else — a second disk, or a synced folder — choose the " +
        "folder below.",
  ]
    .filter(Boolean)
    .join(" ");
}

async function open(): Promise<{ db: DatabaseSync; dataDir: string }> {
  const found = locateZoteroDataDir();
  const dataDir = found.path;
  if (!dataDir) throw new ZoteroError(noLibraryHere(found, { paths: true }));
  try {
    const path = await snapshot(dataDir);
    const db = new DatabaseSync(path, { readOnly: true });
    /*
     * Touch it before handing it over.
     *
     * `new DatabaseSync` does not read the file, so a snapshot that is not a
     * database at all constructs happily and throws on the first statement --
     * outside this try, where the explanation below never runs and the caller
     * shows SQLite's bare "file is not a database". One cheap query moves the
     * failure to where it can be explained.
     */
    try {
      db.prepare("SELECT count(*) FROM sqlite_schema").get();
    } catch (err) {
      db.close();
      throw err;
    }
    return { db, dataDir };
  } catch (err) {
    /*
     * Says what THIS route found and nothing about the other one.
     *
     * It used to open with "Zotero's local API did not answer", which is the
     * caller's business: `inspectLibraryFile` probes both routes side by side
     * for the Settings panel, so that sentence appeared underneath a green
     * card reporting the API answering with 20 collections. Two cards, one of
     * them contradicting the other, in a pane whose entire job is to say which
     * route is in use.
     */
    throw new ZoteroError(
      `Zotero's database at ${join(dataDir, ZOTERO_DB)} could not be read: ` +
        describeOpenFailure(err, dataDir),
    );
  }
}

/**
 * A reason, when SQLite gives one, and evidence when it does not.
 *
 * Reported from a real library: "could not be read either: not an error".
 * That is `sqlite3_errstr(SQLITE_OK)` -- a failure raised with no error code
 * set -- and as a sentence shown to a user it is worse than saying nothing,
 * because it denies there is a problem while being the problem. So an
 * unhelpful message is replaced by what can be checked from outside SQLite:
 * whether the file is there, how big it is, and whether this process may read
 * it. One of those is wrong in every case that reaches here.
 */
function describeOpenFailure(err: unknown, dataDir: string): string {
  const raw = (err as Error)?.message?.trim() ?? "";
  const useless = !raw || /^not an error$/i.test(raw) || /^unknown error$/i.test(raw);
  const path = join(dataDir, ZOTERO_DB);
  let evidence: string;
  try {
    const info = statSync(path);
    let readable = true;
    try {
      accessSync(path, constants.R_OK);
    } catch {
      readable = false;
    }
    evidence = readable
      ? `the file is there and is ${Math.round(info.size / 1024)} KB, and MyRA can read it, ` +
        "so SQLite refused it for a reason it did not report — Zotero may have it open " +
        "exclusively. Closing Zotero and pressing Check again will say whether that is it."
      : "the file is there but this account does not have permission to read it.";
  } catch {
    evidence = "there is no file at that path now, though Zotero's settings point at it.";
  }
  return useless ? evidence : raw;
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

/**
 * What the file route can actually do right now, in numbers.
 *
 * Separate from a search because it answers a different question: not "what
 * matches" but "is this the library I think it is". It counts rather than
 * describing, because a count is the one thing a user can check against what
 * Zotero shows them.
 */
export async function inspectLibraryFile(): Promise<{
  found: DirFinding;
  ok: boolean;
  message: string;
  items?: number;
  collections?: number;
}> {
  const found = locateZoteroDataDir();
  if (!found.path) return { found, ok: false, message: noLibraryHere(found) };
  try {
    const { db } = await open();
    try {
      const row = db.prepare(ITEM_COUNT_SQL).get() as { n?: unknown } | undefined;
      const items = typeof row?.n === "number" ? row.n : 0;
      const collections = (db.prepare(COLLECTIONS_SQL).all() as unknown[]).length;
      return {
        found,
        ok: true,
        message: `Read ${items} item${items === 1 ? "" : "s"} and ${collections} collection${
          collections === 1 ? "" : "s"
        } from ${join(found.path, ZOTERO_DB)}.`,
        items,
        collections,
      };
    } finally {
      db.close();
    }
  } catch (err) {
    return { found, ok: false, message: (err as Error).message };
  }
}
