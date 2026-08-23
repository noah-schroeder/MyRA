/**
 * Evolution Data Server, over D-Bus.
 *
 * Calendar and contacts live on the host and are read here, never in the VM.
 * The agent gets structured results through the broker; it never touches EDS.
 *
 * Everything goes through `busctl --json=short` rather than a native D-Bus
 * binding, for the same reason Planify goes through `flatpak`: no compiled
 * dependency in an Electron app that must ship as a .deb, and the call is
 * inspectable in the audit log as the exact command that ran.
 *
 * Shapes below were confirmed against a live EDS 3.5x rather than from docs:
 *   - a source list comes from the ObjectManager on Sources5
 *   - CreateObjects takes a BARE VEVENT with LF endings; a VCALENDAR wrapper or
 *     CRLF is rejected as "Invalid object"
 *   - GetObjectList returns VEVENTs with CRLF, so parsing must accept both
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 20_000;

const SOURCES = "org.gnome.evolution.dataserver.Sources5";
const CALENDAR = "org.gnome.evolution.dataserver.Calendar8";
const ADDRESSBOOK = "org.gnome.evolution.dataserver.AddressBook10";

export class EdsError extends Error {
  override readonly name = "EdsError";
}

export interface CalendarEvent {
  uid: string;
  summary: string;
  /** ISO 8601 where the value could be understood, else the raw ICS value. */
  start: string;
  end?: string;
  allDay?: boolean;
  location?: string;
  description?: string;
  calendar?: string;
}

export interface Contact {
  uid: string;
  name: string;
  emails: string[];
  phones: string[];
  organisation?: string;
  addressBook?: string;
}

export interface NewEvent {
  summary: string;
  /** ISO 8601, or a bare date for an all-day event. */
  start: string;
  end?: string;
  location?: string;
  description?: string;
}

/* ------------------------------------------------------------------ *
 * D-Bus plumbing                                                      *
 * ------------------------------------------------------------------ */

async function busctl(args: string[]): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync("busctl", ["--user", "--json=short", ...args], {
      timeout: TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(stdout) as unknown;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") {
      throw new EdsError("busctl is not installed on this host (package: systemd)");
    }
    const detail = (e.stderr ?? e.message ?? "").trim();
    if (/ServiceUnknown|not provided by any/.test(detail)) {
      throw new EdsError("Evolution Data Server is not running on this host");
    }
    throw new EdsError(detail || "D-Bus call failed");
  }
}

/** busctl wraps every reply as { type, data: [...] }. */
function replyData(reply: unknown): unknown[] {
  const d = (reply as { data?: unknown[] })?.data;
  return Array.isArray(d) ? d : [];
}

async function call(dest: string, path: string, iface: string, method: string, ...args: string[]) {
  return replyData(await busctl(["call", dest, path, iface, method, ...args]));
}

/* ------------------------------------------------------------------ *
 * Sources                                                            *
 * ------------------------------------------------------------------ */

export type SourceKind = "Calendar" | "Address Book";

export interface Source {
  uid: string;
  name: string;
}

/**
 * Enabled sources of one kind.
 *
 * The Data blob is an INI document carrying DisplayName in ~90 languages; only
 * the untranslated key is wanted, so it is read rather than the whole thing
 * being parsed.
 */
export async function listSources(kind: SourceKind): Promise<Source[]> {
  const data = await call(
    SOURCES,
    "/org/gnome/evolution/dataserver/SourceManager",
    "org.freedesktop.DBus.ObjectManager",
    "GetManagedObjects",
  );
  const objects = (data[0] ?? {}) as Record<string, Record<string, Record<string, { data?: unknown }>>>;

  const out: Source[] = [];
  for (const ifaces of Object.values(objects)) {
    const src = ifaces["org.gnome.evolution.dataserver.Source"];
    const uid = src?.["UID"]?.data;
    const blob = src?.["Data"]?.data;
    if (typeof uid !== "string" || typeof blob !== "string") continue;

    const lines = blob.split("\n");
    if (!lines.some((l) => l.trim() === `[${kind}]`)) continue;
    // A disabled source answers no queries, so offering it would be a lie.
    const enabled = lines.find((l) => l.startsWith("Enabled="))?.slice("Enabled=".length).trim();
    if (enabled === "false") continue;

    const name = lines.find((l) => l.startsWith("DisplayName="))?.slice("DisplayName=".length).trim();
    out.push({ uid, name: name || uid });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * iCalendar / vCard parsing                                          *
 * ------------------------------------------------------------------ */

/**
 * Unfold and split a content line into { name, params, value }.
 *
 * Both formats fold long lines by inserting a newline plus one space or tab,
 * and both arrive with either CRLF or LF depending on who wrote them, so this
 * has to handle all four combinations.
 */
export function contentLines(text: string): { name: string; params: string; value: string }[] {
  const unfolded = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
  const out: { name: string; params: string; value: string }[] = [];
  for (const line of unfolded.split("\n")) {
    if (!line.trim()) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const semi = head.indexOf(";");
    out.push({
      name: (semi === -1 ? head : head.slice(0, semi)).toUpperCase(),
      params: semi === -1 ? "" : head.slice(semi + 1),
      value,
    });
  }
  return out;
}

/** Undo the escaping both formats apply to text values. */
function unescapeText(v: string): string {
  return v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

/**
 * Turn an ICS date-time into ISO 8601 where that can be done honestly.
 *
 * A floating or TZID-qualified local time has no offset in the value itself, so
 * it is returned as a local ISO string with no Z -- claiming UTC would move the
 * appointment. An unrecognised shape is returned untouched rather than guessed.
 */
export function icsDate(value: string): { iso: string; allDay: boolean } {
  const v = value.trim();
  const utc = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v);
  if (utc) {
    const [, y, mo, d, h, mi, s] = utc;
    return { iso: `${y}-${mo}-${d}T${h}:${mi}:${s}Z`, allDay: false };
  }
  const local = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(v);
  if (local) {
    const [, y, mo, d, h, mi, s] = local;
    return { iso: `${y}-${mo}-${d}T${h}:${mi}:${s}`, allDay: false };
  }
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (date) {
    const [, y, mo, d] = date;
    return { iso: `${y}-${mo}-${d}`, allDay: true };
  }
  return { iso: v, allDay: false };
}

export function parseEvent(ics: string, calendar?: string): CalendarEvent | undefined {
  let uid = "", summary = "", location = "", description = "";
  let start: { iso: string; allDay: boolean } | undefined;
  let end: { iso: string; allDay: boolean } | undefined;

  for (const { name, value } of contentLines(ics)) {
    switch (name) {
      case "UID": uid = value.trim(); break;
      case "SUMMARY": summary = unescapeText(value); break;
      case "LOCATION": location = unescapeText(value); break;
      case "DESCRIPTION": description = unescapeText(value); break;
      case "DTSTART": start = icsDate(value); break;
      case "DTEND": end = icsDate(value); break;
      default: break;
    }
  }
  if (!start) return undefined;
  return {
    uid,
    summary: summary || "(no title)",
    start: start.iso,
    ...(end ? { end: end.iso } : {}),
    ...(start.allDay ? { allDay: true } : {}),
    ...(location ? { location } : {}),
    ...(description ? { description } : {}),
    ...(calendar ? { calendar } : {}),
  };
}

export function parseContact(vcard: string, addressBook?: string): Contact | undefined {
  let uid = "", fn = "", n = "", org = "";
  const emails: string[] = [];
  const phones: string[] = [];

  for (const { name, value } of contentLines(vcard)) {
    switch (name) {
      case "UID": uid = value.trim(); break;
      case "FN": fn = unescapeText(value); break;
      // Structured name: Family;Given;Additional;Prefix;Suffix
      case "N": n = unescapeText(value).split(";").slice(0, 2).reverse().join(" ").trim(); break;
      case "ORG": org = unescapeText(value).split(";")[0]!.trim(); break;
      case "EMAIL": if (value.trim()) emails.push(value.trim()); break;
      case "TEL": if (value.trim()) phones.push(value.trim()); break;
      default: break;
    }
  }
  const display = fn || n;
  if (!display && emails.length === 0) return undefined;
  return {
    uid,
    name: display || emails[0]!,
    emails,
    phones,
    ...(org ? { organisation: org } : {}),
    ...(addressBook ? { addressBook } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Queries                                                            *
 * ------------------------------------------------------------------ */

/** EDS S-expression string literals are double-quoted; escape accordingly. */
function sexpString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function icsStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

async function openSource(
  kind: SourceKind,
  uid: string,
): Promise<{ dest: string; path: string; iface: string }> {
  const isCal = kind === "Calendar";
  const dest = isCal ? CALENDAR : ADDRESSBOOK;
  const factoryPath = isCal
    ? "/org/gnome/evolution/dataserver/CalendarFactory"
    : "/org/gnome/evolution/dataserver/AddressBookFactory";
  const factoryIface = isCal
    ? "org.gnome.evolution.dataserver.CalendarFactory"
    : "org.gnome.evolution.dataserver.AddressBookFactory";
  const method = isCal ? "OpenCalendar" : "OpenAddressBook";
  const iface = isCal
    ? "org.gnome.evolution.dataserver.Calendar"
    : "org.gnome.evolution.dataserver.AddressBook";

  const reply = await call(dest, factoryPath, factoryIface, method, "s", uid);
  const [path] = reply as [string, string];
  if (typeof path !== "string" || !path) throw new EdsError(`could not open ${kind} "${uid}"`);
  await call(dest, path, iface, "Open");
  return { dest, path, iface };
}

export interface ListEventsOptions {
  /** ISO date or date-time. Defaults to now. */
  from?: string;
  /** ISO date or date-time. Defaults to 7 days after `from`. */
  to?: string;
  limit?: number;
}

export async function listEvents(opts: ListEventsOptions = {}): Promise<CalendarEvent[]> {
  const from = opts.from ? new Date(opts.from) : new Date();
  if (Number.isNaN(from.getTime())) throw new EdsError(`could not read "from" as a date: ${opts.from}`);
  const to = opts.to ? new Date(opts.to) : new Date(from.getTime() + 7 * 86_400_000);
  if (Number.isNaN(to.getTime())) throw new EdsError(`could not read "to" as a date: ${opts.to}`);

  const query = `(occur-in-time-range? (make-time "${icsStamp(from)}") (make-time "${icsStamp(to)}"))`;
  const events: CalendarEvent[] = [];

  for (const source of await listSources("Calendar")) {
    try {
      const { dest, path, iface } = await openSource("Calendar", source.uid);
      const reply = await call(dest, path, iface, "GetObjectList", "s", query);
      for (const ics of (reply[0] ?? []) as string[]) {
        const event = parseEvent(ics, source.name);
        if (event) events.push(event);
      }
    } catch {
      // One unreadable calendar must not empty the whole answer: a stale remote
      // source is common and the other calendars are still worth returning.
      continue;
    }
  }

  events.sort((a, b) => a.start.localeCompare(b.start));
  return typeof opts.limit === "number" ? events.slice(0, opts.limit) : events;
}

export interface SearchContactsOptions {
  query: string;
  limit?: number;
}

export async function searchContacts(opts: SearchContactsOptions): Promise<Contact[]> {
  const needle = opts.query.trim();
  if (!needle) throw new EdsError("a search term is required");
  const query = `(contains "x-evolution-any-field" ${sexpString(needle)})`;
  const contacts: Contact[] = [];

  for (const source of await listSources("Address Book")) {
    try {
      const { dest, path, iface } = await openSource("Address Book", source.uid);
      const reply = await call(dest, path, iface, "GetContactList", "s", query);
      for (const vcard of (reply[0] ?? []) as string[]) {
        const contact = parseContact(vcard, source.name);
        if (contact) contacts.push(contact);
      }
    } catch {
      continue;
    }
  }

  contacts.sort((a, b) => a.name.localeCompare(b.name));
  return typeof opts.limit === "number" ? contacts.slice(0, opts.limit) : contacts;
}

/* ------------------------------------------------------------------ *
 * Creating an event -- reached only by a human click                  *
 * ------------------------------------------------------------------ */

function icsEscape(v: string): string {
  return v.replace(/([\\,;])/g, "\\$1").replace(/\n/g, "\\n");
}

/** Format for DTSTART/DTEND: bare date for all-day, UTC stamp otherwise. */
function icsValue(iso: string): { param: string; value: string } {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return { param: ";VALUE=DATE", value: iso.replace(/-/g, "") };
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new EdsError(`could not read as a date: ${iso}`);
  return { param: "", value: icsStamp(d) };
}

export function buildVevent(event: NewEvent, uid: string, now = new Date()): string {
  const start = icsValue(event.start);
  const end = event.end ? icsValue(event.end) : undefined;
  const lines = [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${icsStamp(now)}`,
    `DTSTART${start.param}:${start.value}`,
    ...(end ? [`DTEND${end.param}:${end.value}`] : []),
    `SUMMARY:${icsEscape(event.summary)}`,
    ...(event.location ? [`LOCATION:${icsEscape(event.location)}`] : []),
    ...(event.description ? [`DESCRIPTION:${icsEscape(event.description)}`] : []),
    "END:VEVENT",
  ];
  // LF, and no VCALENDAR wrapper: EDS rejects both alternatives as
  // "Invalid object". Confirmed against a live server.
  return lines.join("\n") + "\n";
}

/**
 * Create an event. Reached only from the review queue, never from the agent.
 *
 * `calendar.propose_event` returns a proposal and touches nothing; this runs
 * when the user clicks to accept it.
 */
export async function createEvent(event: NewEvent, calendarUid?: string): Promise<{ uid: string; calendar: string }> {
  const sources = await listSources("Calendar");
  if (sources.length === 0) throw new EdsError("no calendar is configured on this host");
  const target = calendarUid
    ? sources.find((s) => s.uid === calendarUid || s.name === calendarUid)
    : sources.find((s) => s.uid === "system-calendar") ?? sources[0];
  if (!target) throw new EdsError(`no such calendar: ${calendarUid}`);

  const uid = `karen-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const { dest, path, iface } = await openSource("Calendar", target.uid);
  await call(dest, path, iface, "CreateObjects", "asu", "1", buildVevent(event, uid), "0");
  return { uid, calendar: target.name };
}
