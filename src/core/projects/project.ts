/**
 * A project: everything about one piece of work, in one place.
 *
 * Karen makes five kinds of thing and keeps each in its own store — a
 * conversation in `~/.config/karen/sessions`, a meeting in its own directory
 * under the meetings root, a research run under the research root, a paper and
 * an image each as a record under theirs. Nobody works in those five
 * categories. They work on *the NSF concept note*, which is three
 * conversations, a kickoff meeting, a literature run, a draft and two figures,
 * and until this existed nothing in the app said those six things had anything
 * to do with each other.
 *
 * ## Why this is an index and not a folder
 *
 * A project lists what belongs to it. The files never move.
 *
 * The obvious alternative — a real directory per project, everything inside it
 * — was costed and rejected, and the reason is worth keeping because it will be
 * proposed again. As soon as items live in different directories, every "open
 * this by id" call has to first discover *which* directory holds it, so that
 * design needs an index anyway; on top of it, the research run root would have
 * to be threaded through the pipeline and its resume logic, the meetings jail
 * widened past `meetingsRoot`, and conversations moved out of `~/.config` into
 * `~/Documents`, where a file manager and any cloud sync can read them. Five
 * subsystems, two of them long-running and resumable, to arrive somewhere that
 * still needs this file.
 *
 * "All of it together on disk" is a real want, and it is answered by exporting
 * a folder rather than by living in one. See [render.ts](./render.ts).
 *
 * Pure: no disk, no Electron. [main/projects.ts](../../main/projects.ts) owns
 * the files and resolves members against the five stores.
 */

/**
 * The kinds of thing a project can hold. Six are things MyRA made; `source`
 * -- a paper somebody uploaded into the project -- is the one it did not, and
 * the only one that exists only because a project does.
 */
export type MemberKind = "chat" | "meeting" | "run" | "paper" | "review" | "image" | "source";

export const MEMBER_KINDS: readonly MemberKind[] = [
  "chat",
  "meeting",
  "run",
  "paper",
  "review",
  "image",
  "source",
];

/**
 * One thing in a project.
 *
 * `ref` is whatever that store addresses an item by, and for five of the six
 * that is an id. Meetings are addressed by directory, and what is stored here
 * is the directory's **name**, not its path: an absolute path would break the
 * moment somebody moved their meetings folder in Settings, which is a thing the
 * app invites them to do.
 */
export interface Member {
  kind: MemberKind;
  ref: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  members: Member[];
  /**
   * Zotero collections this project reads from, by key, with the name each
   * had when it was linked (shown if Zotero no longer has it). Several,
   * because a thesis draws on more than one shelf. Not members: a collection
   * is not a thing MyRA made, and linking one to two projects is fine.
   */
  collections?: ProjectCollection[];
}

export interface ProjectCollection {
  key: string;
  name: string;
}

/** Zotero's own key shape -- the same test `isCollectionKey` in library/zotero.ts applies. */
const COLLECTION_KEY = /^[A-Z0-9]{8}$/;

/** A generous ceiling that no real project reaches, so a corrupt record cannot fan a search out without end. */
export const MAX_PROJECT_COLLECTIONS = 25;

/**
 * Collections as they may be stored: known shape, deduplicated, capped.
 * Applied to what the window sends and to what is read back off disk alike.
 */
export function cleanCollections(raw: unknown): ProjectCollection[] {
  const out: ProjectCollection[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const key = typeof row["key"] === "string" ? row["key"] : "";
    if (!COLLECTION_KEY.test(key) || seen.has(key)) continue;
    const name = typeof row["name"] === "string" ? row["name"].trim().slice(0, 200) : "";
    seen.add(key);
    out.push({ key, name: name || key });
    if (out.length >= MAX_PROJECT_COLLECTIONS) break;
  }
  return out;
}

/** Link these collections, replacing whatever was linked. `updatedAt` moves only if something changed. */
export function setCollections(project: Project, collections: readonly ProjectCollection[], now = new Date()): Project {
  const next = cleanCollections(collections);
  const before = project.collections ?? [];
  if (next.length === before.length && next.every((c, i) => c.key === before[i]!.key && c.name === before[i]!.name)) {
    return project;
  }
  const { collections: _drop, ...rest } = project;
  return { ...(next.length ? { ...rest, collections: next } : rest), updatedAt: now.toISOString() };
}

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  items: number;
  /** Linked Zotero collections, so the research bar can say a project's scope is in force. */
  collections?: ProjectCollection[];
}

/** Singular and plural, for a confirm dialog that has to name what it removes. */
const KIND_WORDS: Record<MemberKind, [string, string]> = {
  chat: ["conversation", "conversations"],
  meeting: ["meeting", "meetings"],
  run: ["research run", "research runs"],
  paper: ["paper", "papers"],
  review: ["peer review", "peer reviews"],
  image: ["image", "images"],
  source: ["uploaded paper", "uploaded papers"],
};

export function kindLabel(kind: MemberKind, count: number): string {
  const [one, many] = KIND_WORDS[kind];
  return count === 1 ? one : many;
}

function randomSalt(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 4);
}

/**
 * A short, legible, filesystem-safe id: date, time, and a slug of the name.
 *
 * The same shape images, papers and research runs use. The salt is real
 * entropy rather than a counter, because two projects created in the same
 * minute would otherwise collide on the filename and the second would
 * overwrite the first.
 */
export function projectId(name: string, now = new Date(), salt = randomSalt()): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}` +
    `-${two(now.getHours())}${two(now.getMinutes())}`;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .split("-")
    .filter(Boolean)
    .slice(0, 6)
    .join("-")
    .slice(0, 60);
  return `${stamp}-${slug || "project"}${salt ? `-${salt}` : ""}`;
}

/**
 * A project id, refused if it is anything but one.
 *
 * The same guard `assertImageId`, `assertRunId` and `assertPaperId` are, for
 * the same reason: this comes back from a sandboxed window to be joined onto
 * the projects directory and then read, written and deleted.
 */
export function assertProjectId(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") {
    throw new Error(`no project named ${JSON.stringify(id)}`);
  }
  return id;
}

/**
 * The shape every member reference shares, whichever store owns it.
 *
 * Not a sixth opinion: this is the INTERSECTION of the guards that already
 * exist -- assertRunId, assertPaperId, assertReviewId, assertImageId and the
 * regex in sessions.ts all spell it exactly this way. Stated once here so a
 * record arriving from disk can be held to it without reaching a store, which
 * `parseProject` cannot do: it takes an id and nothing else.
 *
 * A ref reaches `join()` in main/projects.ts, and for a meeting it reaches
 * `rm -rf`, because a meeting is addressed by its DIRECTORY NAME rather than
 * by an id. `../../../..` was accepted here.
 */
export function isMemberRef(ref: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(ref) && ref !== "." && ref !== "..";
}

export function newProject(opts: { name: string; id?: string; now?: Date }): Project {
  const now = opts.now ?? new Date();
  const name = opts.name.trim() || "Untitled project";
  const at = now.toISOString();
  return {
    id: opts.id ?? projectId(name, now),
    name,
    createdAt: at,
    updatedAt: at,
    members: [],
  };
}

/* ------------------------------------------------------------------ *
 * Membership                                                          *
 * ------------------------------------------------------------------ */

/**
 * Two members are the same only when both halves match.
 *
 * Compared on the pair, never on the ref alone. The five stores mint their ids
 * independently and four of them start with the same date stamp, so
 * `20260907-1405-kickoff` is a plausible id in more than one of them —
 * and a project that removed a paper because a meeting shared its name would
 * be a bug nobody could reproduce on demand.
 */
export function sameMember(a: Member, b: Member): boolean {
  return a.kind === b.kind && a.ref === b.ref;
}

export function hasMember(project: Project, member: Member): boolean {
  return project.members.some((m) => sameMember(m, member));
}

/** Which project holds this, if any. */
export function ownerOf(projects: readonly Project[], member: Member): Project | undefined {
  return projects.find((p) => hasMember(p, member));
}

/**
 * Put these in that project, and take them out of any other.
 *
 * Every project comes in and every project goes out, because membership is
 * **exclusive** and moving something into one is therefore an edit to two. A
 * folder that could hold a conversation another folder also held would make
 * "delete this project and everything in it" a question with no answer.
 *
 * `updatedAt` moves only on the projects that actually changed, so a list
 * ordered by it is not reshuffled by an operation that touched nothing.
 */
export function addMembers(
  projects: readonly Project[],
  projectId: string,
  members: readonly Member[],
  now = new Date(),
): Project[] {
  const at = now.toISOString();
  return projects.map((project) => {
    if (project.id === projectId) {
      const added = members.filter((m) => !hasMember(project, m));
      if (!added.length) return project;
      return { ...project, members: [...project.members, ...added], updatedAt: at };
    }
    const kept = project.members.filter((m) => !members.some((x) => sameMember(m, x)));
    if (kept.length === project.members.length) return project;
    return { ...project, members: kept, updatedAt: at };
  });
}

/** Take these out of this project. The items themselves are untouched. */
export function removeMembers(
  project: Project,
  members: readonly Member[],
  now = new Date(),
): Project {
  const kept = project.members.filter((m) => !members.some((x) => sameMember(m, x)));
  if (kept.length === project.members.length) return project;
  return { ...project, members: kept, updatedAt: now.toISOString() };
}

/**
 * Drop members whose item is no longer there.
 *
 * Called on every read rather than on deletion, because the five stores each
 * have their own delete on their own page and none of them has ever heard of
 * projects. A conversation removed from the rail must not leave a row in a
 * project that opens nothing — and asking "is it still there?" at read time is
 * cheaper and more honest than trying to keep five deletes in step.
 *
 * `updatedAt` deliberately does NOT move: pruning is Karen noticing something,
 * not the user doing something, and a project that reordered itself in the list
 * because a chat was deleted elsewhere would be reporting the wrong event.
 */
export function pruneMembers(project: Project, alive: (member: Member) => boolean): Project {
  const kept = project.members.filter(alive);
  return kept.length === project.members.length ? project : { ...project, members: kept };
}

/**
 * The rows the rail shows: one project's work, or the work that is in none.
 *
 * The two groups are disjoint and there is no view showing both, which is what
 * makes "Delete all conversations" a broom for loose work rather than a button
 * that empties a project it never named.
 *
 * The other half of that is the one people actually notice: with no project
 * named, this is everything that is in no project -- so a conversation started
 * while no project is open is in this list, which is the ordinary way to use
 * the app and must never depend on projects existing at all.
 */
export function railRows<T extends { project: string }>(
  rows: readonly T[],
  projectId?: string,
): T[] {
  return rows.filter((row) => (projectId ? row.project === projectId : !row.project));
}

/**
 * The newest `limit` rows of each project, and of the loose ones.
 *
 * The rail shows one of those groups at a time -- either the work that is in no
 * project, or one project's own -- never the two together, so a limit counted
 * across the whole list is a limit on the wrong thing: fifty items filed into
 * projects would empty a list that was never going to show them anyway.
 *
 * Takes the rows in the order they are wanted in and keeps it, so "newest" is
 * whatever the caller already sorted by.
 */
export function perProjectLimit<T extends { project: string }>(
  rows: readonly T[],
  limit: number,
): T[] {
  const taken = new Map<string, number>();
  return rows.filter((row) => {
    const n = taken.get(row.project) ?? 0;
    if (n >= limit) return false;
    taken.set(row.project, n + 1);
    return true;
  });
}

/** How many of each kind, for a dialog that has to say what it is about to do. */
export function countsOf(members: readonly Member[]): Record<MemberKind, number> {
  const counts = { chat: 0, meeting: 0, run: 0, paper: 0, review: 0, image: 0, source: 0 };
  for (const member of members) counts[member.kind] += 1;
  return counts;
}

export function summaryOf(project: Project): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    items: project.members.length,
    ...(project.collections?.length ? { collections: project.collections } : {}),
  };
}

/** Most recently worked in first, which is the order the rail reads them. */
export function byNewest(a: ProjectSummary, b: ProjectSummary): number {
  return b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id);
}

/**
 * A record read back off disk, rebuilt field by field.
 *
 * The same discipline the other stores get. This one is not in a folder the
 * user is invited to open, so a hand edit is unlikely — but a truncated write
 * or a half-synced file is not, and a rail that throws on the third of five
 * projects is worse than one that skips it.
 */
export function parseProject(raw: unknown, id: string): Project | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const text = (key: string, fallback = ""): string =>
    typeof row[key] === "string" ? (row[key] as string) : fallback;

  const members: Member[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(row["members"]) ? row["members"] : []) {
    if (!entry || typeof entry !== "object") continue;
    const m = entry as Record<string, unknown>;
    const kind = m["kind"];
    const ref = m["ref"];
    if (typeof ref !== "string" || !ref) continue;
    if (!MEMBER_KINDS.includes(kind as MemberKind)) continue;
    /* Dropped rather than repaired, the same way an unknown kind is. A record
       on disk is an input: this file is written by MyRA, but it sits in a
       directory the user and any sync client can reach, and the ref is about
       to be joined onto a root. */
    if (!isMemberRef(ref)) continue;
    /* Deduplicated on the way in. A record written by a build with a bug in it
       is not a reason to count the same meeting twice in the delete dialog. */
    const key = `${String(kind)} ${ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    members.push({ kind: kind as MemberKind, ref });
  }

  const createdAt = text("createdAt");
  const collections = cleanCollections(row["collections"]);
  return {
    id,
    name: text("name") || "Untitled project",
    createdAt,
    updatedAt: text("updatedAt", createdAt),
    members,
    ...(collections.length ? { collections } : {}),
  };
}
