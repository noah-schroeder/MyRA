/**
 * A synthetic zotero.sqlite, built to Zotero's own published schema.
 *
 * There is no Zotero install on the machine this is developed on, so the only
 * way to establish that the SQLite route is correct is to run it against a
 * database with the same tables, columns and keys as the real one
 * (https://www.zotero.org/support/dev/client_coding/direct_sqlite_database_access).
 *
 * A builder rather than a checked-in binary: a binary fixture cannot be read in
 * a diff, and each test needs to control what is in the library -- what is
 * trashed, what is in a group library, what is filed where.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCHEMA = `
CREATE TABLE libraries (libraryID INTEGER PRIMARY KEY, type TEXT NOT NULL);
CREATE TABLE itemTypes (itemTypeID INTEGER PRIMARY KEY, typeName TEXT);
CREATE TABLE items (
  itemID INTEGER PRIMARY KEY, itemTypeID INT NOT NULL, key TEXT NOT NULL,
  libraryID INT NOT NULL, dateAdded TEXT, dateModified TEXT
);
CREATE TABLE fields (fieldID INTEGER PRIMARY KEY, fieldName TEXT);
CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value UNIQUE);
CREATE TABLE itemData (itemID INT, fieldID INT, valueID INT, PRIMARY KEY (itemID, fieldID));
CREATE TABLE creators (
  creatorID INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT, fieldMode INT
);
CREATE TABLE creatorTypes (creatorTypeID INTEGER PRIMARY KEY, creatorType TEXT);
CREATE TABLE itemCreators (
  itemID INT, creatorID INT, creatorTypeID INT, orderIndex INT,
  PRIMARY KEY (itemID, creatorID, creatorTypeID, orderIndex)
);
CREATE TABLE itemAttachments (
  itemID INTEGER PRIMARY KEY, parentItemID INT, linkMode INT, contentType TEXT,
  charsetID INT, path TEXT, syncState INT DEFAULT 0
);
CREATE TABLE itemNotes (itemID INTEGER PRIMARY KEY, parentItemID INT, note TEXT, title TEXT);
CREATE TABLE tags (tagID INTEGER PRIMARY KEY, name TEXT UNIQUE);
CREATE TABLE itemTags (itemID INT, tagID INT, type INT, PRIMARY KEY (itemID, tagID));
CREATE TABLE collections (
  collectionID INTEGER PRIMARY KEY, collectionName TEXT NOT NULL,
  parentCollectionID INT, libraryID INT NOT NULL, key TEXT NOT NULL
);
CREATE TABLE collectionItems (
  collectionID INT, itemID INT, orderIndex INT DEFAULT 0, PRIMARY KEY (collectionID, itemID)
);
CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY, dateDeleted DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE deletedCollections (collectionID INTEGER PRIMARY KEY, dateDeleted DEFAULT CURRENT_TIMESTAMP NOT NULL);
`;

const TYPES = ["journalArticle", "book", "conferencePaper", "preprint", "attachment", "note"];
const FIELDS = [
  "title", "shortTitle", "publicationTitle", "bookTitle", "proceedingsTitle", "repository",
  "date", "DOI", "url", "abstractNote", "extra",
];

export interface FakeItem {
  key: string;
  type?: string;
  library?: number;
  modified?: string;
  fields?: Record<string, string>;
  /** `["Lastname, Firstname"]`, or `["Institution"]` for a single-field name. */
  creators?: string[];
  tags?: string[];
  note?: string;
  trashed?: boolean;
  collections?: string[];
  /** Child attachments, as Zotero stores them: an item of its own plus an itemAttachments row. */
  attachments?: FakeAttachment[];
}

export interface FakeAttachment {
  key: string;
  /** 0 imported_file, 1 imported_url, 2 linked_file, 3 linked_url. */
  linkMode: number;
  /** `storage:name.pdf`, an absolute path, or `attachments:relative.pdf`. */
  path: string;
  contentType?: string;
  trashed?: boolean;
}

export interface FakeCollection {
  key: string;
  name: string;
  parent?: string;
  library?: number;
  deleted?: boolean;
}

/**
 * Writes a library to a fresh directory and returns the directory.
 *
 * `wal` leaves the database in write-ahead-logging mode with rows still in the
 * log, which is the state a real Zotero's file is in the whole time it runs. A
 * reader that ignores the log sees a library missing everything added since the
 * last checkpoint -- and reports it as an empty search rather than an error.
 */
export function buildLibrary(
  items: FakeItem[],
  collections: FakeCollection[] = [],
  opts: { wal?: boolean } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "myra-zotero-"));
  const db = new DatabaseSync(join(dir, "zotero.sqlite"));
  if (opts.wal) db.exec("PRAGMA journal_mode=WAL");
  db.exec(SCHEMA);

  db.prepare("INSERT INTO libraries VALUES (?, ?)").run(1, "user");
  db.prepare("INSERT INTO libraries VALUES (?, ?)").run(2, "group");
  TYPES.forEach((name, i) => db.prepare("INSERT INTO itemTypes VALUES (?, ?)").run(i + 1, name));
  FIELDS.forEach((name, i) => db.prepare("INSERT INTO fields VALUES (?, ?)").run(i + 1, name));
  db.prepare("INSERT INTO creatorTypes VALUES (?, ?)").run(1, "author");

  const collectionIds = new Map<string, number>();
  collections.forEach((c, i) => {
    collectionIds.set(c.key, i + 1);
  });
  for (const c of collections) {
    db.prepare("INSERT INTO collections VALUES (?, ?, ?, ?, ?)").run(
      collectionIds.get(c.key)!,
      c.name,
      c.parent ? (collectionIds.get(c.parent) ?? null) : null,
      c.library ?? 1,
      c.key,
    );
    if (c.deleted) {
      db.prepare("INSERT INTO deletedCollections (collectionID) VALUES (?)").run(
        collectionIds.get(c.key)!,
      );
    }
  }

  let valueId = 0;
  let creatorId = 0;
  let tagId = 0;
  const tagIds = new Map<string, number>();

  items.forEach((item, index) => {
    const itemId = index + 1;
    const typeId = TYPES.indexOf(item.type ?? "journalArticle") + 1;
    db.prepare("INSERT INTO items VALUES (?, ?, ?, ?, ?, ?)").run(
      itemId,
      typeId,
      item.key,
      item.library ?? 1,
      "2020-01-01 00:00:00",
      item.modified ?? "2024-01-01 00:00:00",
    );

    for (const [name, value] of Object.entries(item.fields ?? {})) {
      const fieldId = FIELDS.indexOf(name) + 1;
      if (fieldId === 0) throw new Error(`fixture: unknown field ${name}`);
      valueId += 1;
      db.prepare("INSERT INTO itemDataValues VALUES (?, ?)").run(valueId, value);
      db.prepare("INSERT INTO itemData VALUES (?, ?, ?)").run(itemId, fieldId, valueId);
    }

    (item.creators ?? []).forEach((name, order) => {
      creatorId += 1;
      const [last, first] = name.includes(",") ? name.split(",") : [name, undefined];
      db.prepare("INSERT INTO creators VALUES (?, ?, ?, ?)").run(
        creatorId,
        (first ?? "").trim(),
        (last ?? "").trim(),
        first === undefined ? 1 : 0,
      );
      db.prepare("INSERT INTO itemCreators VALUES (?, ?, ?, ?)").run(itemId, creatorId, 1, order);
    });

    for (const tag of item.tags ?? []) {
      if (!tagIds.has(tag)) {
        tagId += 1;
        tagIds.set(tag, tagId);
        db.prepare("INSERT INTO tags VALUES (?, ?)").run(tagId, tag);
      }
      db.prepare("INSERT INTO itemTags VALUES (?, ?, ?)").run(itemId, tagIds.get(tag)!, 0);
    }

    if (item.trashed) db.prepare("INSERT INTO deletedItems (itemID) VALUES (?)").run(itemId);

    for (const key of item.collections ?? []) {
      const id = collectionIds.get(key);
      if (id === undefined) throw new Error(`fixture: unknown collection ${key}`);
      db.prepare("INSERT INTO collectionItems (collectionID, itemID) VALUES (?, ?)").run(id, itemId);
    }
  });

  /* Child notes, added after the items they hang from so the parent ids exist.
     A note is itself an item in Zotero -- that is why a search has to exclude
     the note item type and read the note text through its parent. */
  let noteId = items.length;
  items.forEach((item, index) => {
    if (!item.note) return;
    noteId += 1;
    db.prepare("INSERT INTO items VALUES (?, ?, ?, ?, ?, ?)").run(
      noteId,
      TYPES.indexOf("note") + 1,
      `NOTE${String(noteId).padStart(4, "0")}`,
      item.library ?? 1,
      "2020-01-01 00:00:00",
      "2024-01-01 00:00:00",
    );
    db.prepare("INSERT INTO itemNotes VALUES (?, ?, ?, ?)").run(
      noteId,
      index + 1,
      item.note,
      "note",
    );
  });

  /* Attachments last, for the same reason: they hang from items that must
     already have ids. */
  let attachmentId = noteId;
  items.forEach((item, index) => {
    for (const a of item.attachments ?? []) {
      attachmentId += 1;
      db.prepare("INSERT INTO items VALUES (?, ?, ?, ?, ?, ?)").run(
        attachmentId,
        TYPES.indexOf("attachment") + 1,
        a.key,
        item.library ?? 1,
        "2020-01-01 00:00:00",
        "2024-01-01 00:00:00",
      );
      db.prepare(
        "INSERT INTO itemAttachments (itemID, parentItemID, linkMode, contentType, path) VALUES (?, ?, ?, ?, ?)",
      ).run(attachmentId, index + 1, a.linkMode, a.contentType ?? "application/pdf", a.path);
      if (a.trashed) db.prepare("INSERT INTO deletedItems (itemID) VALUES (?)").run(attachmentId);
    }
  });

  db.close();
  return dir;
}
