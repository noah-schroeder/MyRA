import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVevent, contentLines, icsDate, parseContact, parseEvent } from "../src/main/eds.ts";

/*
 * These parse data that arrives from the user's own calendar and address book,
 * which is to say: real-world iCalendar and vCard, with all the folding and
 * escaping those formats actually use. Shapes below were taken from a live EDS.
 */

test("folded lines are rejoined before parsing", () => {
  // Both formats fold at 75 octets by inserting a newline plus one space.
  const folded = "BEGIN:VEVENT\r\nSUMMARY:A title long enough that a serve\r\n r had to fold it\r\nEND:VEVENT\r\n";
  const summary = contentLines(folded).find((l) => l.name === "SUMMARY")!.value;
  assert.equal(summary, "A title long enough that a server had to fold it");
});

test("CRLF and LF are both accepted", () => {
  // EDS writes CRLF on the way out and demands LF on the way in.
  for (const nl of ["\r\n", "\n"]) {
    const ics = ["BEGIN:VEVENT", "UID:x", "DTSTART:20260825T140000Z", "SUMMARY:Hi", "END:VEVENT"].join(nl);
    assert.equal(parseEvent(ics)!.summary, "Hi");
  }
});

test("a UTC stamp becomes ISO; a local time does not gain a Z", () => {
  assert.deepEqual(icsDate("20260825T140000Z"), { iso: "2026-08-25T14:00:00Z", allDay: false });
  // Claiming UTC for a floating time would move the appointment.
  assert.deepEqual(icsDate("20260825T140000"), { iso: "2026-08-25T14:00:00", allDay: false });
  assert.deepEqual(icsDate("20260825"), { iso: "2026-08-25", allDay: true });
  // Unrecognised shapes come back untouched rather than guessed at.
  assert.deepEqual(icsDate("whenever"), { iso: "whenever", allDay: false });
});

test("escaped commas, semicolons and newlines are restored", () => {
  const ics = [
    "BEGIN:VEVENT", "UID:x", "DTSTART:20260825T140000Z",
    "SUMMARY:Budget\\, scope\; and timing",
    "DESCRIPTION:Line one\\nLine two",
    "END:VEVENT",
  ].join("\n");
  const e = parseEvent(ics)!;
  assert.equal(e.summary, "Budget, scope; and timing");
  assert.equal(e.description, "Line one\nLine two");
});

test("an event with no start is dropped rather than shown at an invented time", () => {
  assert.equal(parseEvent("BEGIN:VEVENT\nUID:x\nSUMMARY:No when\nEND:VEVENT"), undefined);
});

test("a vCard yields every email and phone, not just the first", () => {
  const vcard = [
    "BEGIN:VCARD", "VERSION:3.0", "UID:c1", "FN:Dana Okonkwo-Reyes",
    "N:Okonkwo-Reyes;Dana;;;",
    "EMAIL;TYPE=WORK:dana@example.org", "EMAIL;TYPE=HOME:dana@example.net",
    "TEL;TYPE=CELL:+44 7700 900123",
    "ORG:Example Research Institute;Learning Sciences",
    "END:VCARD",
  ].join("\r\n");
  const c = parseContact(vcard, "Personal")!;
  assert.equal(c.name, "Dana Okonkwo-Reyes");
  assert.deepEqual(c.emails, ["dana@example.org", "dana@example.net"]);
  assert.deepEqual(c.phones, ["+44 7700 900123"]);
  assert.equal(c.organisation, "Example Research Institute");
  assert.equal(c.addressBook, "Personal");
});

test("a contact with only a structured name still gets a display name", () => {
  const c = parseContact("BEGIN:VCARD\nUID:c2\nN:Reyes;Dana;;;\nEND:VCARD")!;
  assert.equal(c.name, "Dana Reyes");
});

test("a nameless contact is identified by its email rather than dropped", () => {
  const c = parseContact("BEGIN:VCARD\nUID:c3\nEMAIL:someone@example.org\nEND:VCARD")!;
  assert.equal(c.name, "someone@example.org");
});

test("a built VEVENT is the exact shape EDS accepts", () => {
  // Measured against a live server: a VCALENDAR wrapper or CRLF endings are
  // both rejected as "Invalid object".
  const ics = buildVevent(
    { summary: "Review, with Dana", start: "2026-08-25T14:00:00Z", end: "2026-08-25T15:00:00Z", location: "Room 3" },
    "uid-1",
    new Date("2026-08-21T12:00:00Z"),
  );
  assert.ok(ics.startsWith("BEGIN:VEVENT\n"), "no VCALENDAR wrapper");
  assert.ok(!ics.includes("\r"), "LF endings only");
  assert.match(ics, /^DTSTART:20260825T140000Z$/m);
  assert.match(ics, /^SUMMARY:Review\\, with Dana$/m, "commas must be escaped");
  assert.match(ics, /^DTSTAMP:20260821T120000Z$/m);
});

test("a bare date builds an all-day event", () => {
  const ics = buildVevent({ summary: "Leave", start: "2026-08-25" }, "uid-2");
  assert.match(ics, /^DTSTART;VALUE=DATE:20260825$/m);
});

test("an unreadable date is refused rather than silently becoming now", () => {
  assert.throws(() => buildVevent({ summary: "x", start: "next tuesday-ish" }, "uid-3"), /could not read as a date/);
});

test("what was built parses back to what went in", () => {
  const original = {
    summary: "Budget, scope; and timing",
    start: "2026-08-25T14:00:00Z",
    end: "2026-08-25T15:30:00Z",
    location: "Room 3",
    description: "Line one\nLine two",
  };
  const parsed = parseEvent(buildVevent(original, "uid-4"))!;
  assert.equal(parsed.summary, original.summary);
  assert.equal(parsed.start, original.start);
  assert.equal(parsed.end, original.end);
  assert.equal(parsed.location, original.location);
  assert.equal(parsed.description, original.description);
});
