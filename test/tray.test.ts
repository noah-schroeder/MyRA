/**
 * Whether a tray icon will actually be seen.
 *
 * This decides whether closing the window hides Karen or quits it, so getting
 * it wrong in the optimistic direction leaves the app running with no way to
 * reach it. The bias is therefore deliberate and tested: anything short of a
 * positive answer is treated as "no tray".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { statusAreaAvailable, statusItemRegistered } from "../src/core/runtime/statusArea.ts";

const WITH_WATCHER = "'org.freedesktop.DBus' 'org.kde.StatusNotifierWatcher' 'org.gnome.Shell'";
const WITHOUT = "'org.freedesktop.DBus' 'org.gnome.Shell' 'org.freedesktop.Notifications'";

test("a registered StatusNotifierWatcher means an icon will show", () => {
  assert.equal(statusAreaAvailable("linux", () => WITH_WATCHER), true);
});

test("no watcher means no icon, however well Tray construction goes", () => {
  // Stock GNOME, Pop!_OS included, without the AppIndicator extension.
  assert.equal(statusAreaAvailable("linux", () => WITHOUT), false);
});

test("an unanswerable question is treated as no", () => {
  // No D-Bus tools installed: hiding into a tray that may not exist is the
  // one outcome worth avoiding, so the uncertain case declines.
  assert.equal(
    statusAreaAvailable("linux", () => {
      throw new Error("ENOENT");
    }),
    false,
  );
});

test("the first tool that answers is believed; a missing one is skipped", () => {
  const tried: string[] = [];
  const available = statusAreaAvailable("linux", (file) => {
    tried.push(file);
    if (file === "gdbus") throw new Error("ENOENT");
    return WITH_WATCHER;
  });
  assert.equal(available, true);
  assert.deepEqual(tried, ["gdbus", "busctl"]);
});

test("macOS and Windows are not asked", () => {
  const asked: string[] = [];
  const run = (f: string): string => {
    asked.push(f);
    return WITHOUT;
  };
  assert.equal(statusAreaAvailable("darwin", run), true);
  assert.equal(statusAreaAvailable("win32", run), true);
  assert.deepEqual(asked, []);
});

/*
 * Whether the desktop COULD show an icon, and whether ours IS showing, are
 * different questions, and this machine answers them differently: watcher
 * registered, AppIndicator extension installed, libayatana-appindicator3
 * present -- and Electron publishes nothing. Reproduced with a bare Electron
 * script and an opaque 22x22 icon, so the difference is not hypothetical.
 */
const ITEMS = (...names: string[]): string =>
  `(<[${names.map((n) => `'${n}'`).join(", ")}]>,)`;

test("an item owned by this process means the icon really is showing", () => {
  const registered = statusItemRegistered(4321, "linux", (_file, args) =>
    args.includes("RegisteredStatusNotifierItems")
      ? ITEMS(":1.50@/org/ayatana/NotificationItem/x", ":1.77@/StatusNotifierItem")
      : args.includes(":1.77")
        ? "(uint32 4321,)"
        : "(uint32 999,)",
  );
  assert.equal(registered, true);
});

test("items that belong to other processes are not ours", () => {
  // The observed state: two indicators registered, neither of them Karen's.
  const registered = statusItemRegistered(4321, "linux", (_file, args) =>
    args.includes("RegisteredStatusNotifierItems")
      ? ITEMS(":1.50@/org/ayatana/NotificationItem/software_update_available")
      : "(uint32 999,)",
  );
  assert.equal(registered, false);
});

test("an empty status area is not ours either", () => {
  assert.equal(statusItemRegistered(4321, "linux", () => "(<@as []>,)"), false);
});

test("a bus that cannot be asked counts as no icon", () => {
  /* Unknown must never mean yes: guessing yes hides the window where nobody
     can reach it, and guessing no only means closing quits. */
  assert.equal(
    statusItemRegistered(4321, "linux", () => {
      throw new Error("ENOENT");
    }),
    false,
  );
});

test("a name that vanishes between the two calls does not fail the check", () => {
  const registered = statusItemRegistered(4321, "linux", (_file, args) => {
    if (args.includes("RegisteredStatusNotifierItems")) return ITEMS(":1.50@/a", ":1.77@/b");
    if (args.includes(":1.50")) throw new Error("no such name");
    return "(uint32 4321,)";
  });
  assert.equal(registered, true);
});

test("macOS and Windows always have somewhere for the icon to be", () => {
  const asked: string[] = [];
  const run = (file: string): string => {
    asked.push(file);
    return "";
  };
  assert.equal(statusItemRegistered(1, "darwin", run), true);
  assert.equal(statusItemRegistered(1, "win32", run), true);
  assert.deepEqual(asked, []);
});
