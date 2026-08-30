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

import { statusAreaAvailable } from "../src/core/runtime/statusArea.ts";

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
