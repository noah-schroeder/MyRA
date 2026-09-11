/**
 * Does this desktop have somewhere for a tray icon to appear?
 *
 * Separate from `main/tray.ts` because that module pulls in Electron, and this
 * question is answerable -- and worth testing -- without a window system.
 */

import { execFileSync } from "node:child_process";

/**
 * Whether this desktop will actually *show* a tray icon.
 *
 * `new Tray(...)` succeeding does not mean an icon appears. On Linux the icon
 * is published over D-Bus to a StatusNotifierItem host, and if nothing is
 * hosting -- stock GNOME, including Pop!_OS, ships without one unless the
 * AppIndicator extension is installed -- construction still succeeds and the
 * icon goes nowhere. That is the worst outcome available: the window hides
 * into a tray that does not exist, and MyRA is running with no way to reach
 * it.
 *
 * So the question is asked of the session bus rather than of Electron: is
 * `org.kde.StatusNotifierWatcher` registered? (KDE's name, used by the
 * freedesktop protocol everyone implements, GNOME's AppIndicator extension
 * included.)
 *
 * **Unknown counts as no.** If none of the D-Bus tools are present the answer
 * cannot be established, and the two mistakes are not equal: guessing "yes"
 * wrongly hides the app where nobody can find it, while guessing "no" wrongly
 * means closing the window quits, which is what every version before the tray
 * did anyway.
 */
export function statusAreaAvailable(
  platform: NodeJS.Platform = process.platform,
  run: (file: string, args: string[]) => string = (file, args) =>
    execFileSync(file, args, { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }),
): boolean {
  // macOS and Windows have a menu bar and a notification area as a given.
  if (platform !== "linux") return true;
  const probes: [file: string, args: string[]][] = [
    ["gdbus", ["call", "--session", "--dest", "org.freedesktop.DBus",
      "--object-path", "/org/freedesktop/DBus", "--method", "org.freedesktop.DBus.ListNames"]],
    ["busctl", ["--user", "list", "--no-pager", "--no-legend"]],
    ["dbus-send", ["--session", "--print-reply", "--dest=org.freedesktop.DBus",
      "/org/freedesktop/DBus", "org.freedesktop.DBus.ListNames"]],
  ];
  for (const [file, args] of probes) {
    try {
      if (run(file, args).includes("org.kde.StatusNotifierWatcher")) return true;
      // The tool ran and the watcher is not there: an answer, not a failure.
      return false;
    } catch {
      // Not installed, or the bus refused. Try the next one.
    }
  }
  return false;
}

/**
 * Did an icon we published actually reach the status area?
 *
 * `statusAreaAvailable` answers whether the DESKTOP can host an icon.
 * Measured on Ubuntu GNOME 
 * -- watcher registered, AppIndicator extension installed,
 * libayatana-appindicator3 present -- that question answers yes while Electron
 * publishes nothing at all: `new Tray(image)` returns a live object, reports no
 * error, and no item appears on the bus. Reproduced with a bare Electron script
 * and a plainly opaque 22x22 icon, so it is not this app's icon or this app's
 * code.
 *
 * That combination is the exact failure tray.ts exists to prevent: the window
 * hides into a tray that is not there. So the question asked before hiding is
 * not "could an icon show" but "is OURS showing", which is answerable -- the
 * watcher lists what is registered, and each entry's bus name resolves to the
 * process that owns it.
 *
 * **Unknown counts as no,** for the same reason as above: guessing yes hides
 * the app where nobody can reach it, and guessing no means closing the window
 * quits, which is merely the older behaviour.
 */
export function statusItemRegistered(
  pid: number = process.pid,
  platform: NodeJS.Platform = process.platform,
  run: (file: string, args: string[]) => string = (file, args) =>
    execFileSync(file, args, { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }),
): boolean {
  if (platform !== "linux") return true;

  let listing: string;
  try {
    listing = run("gdbus", [
      "call", "--session", "--dest", "org.kde.StatusNotifierWatcher",
      "--object-path", "/StatusNotifierWatcher", "--method",
      "org.freedesktop.DBus.Properties.Get",
      "org.kde.StatusNotifierWatcher", "RegisteredStatusNotifierItems",
    ]);
  } catch {
    return false;
  }

  /* Entries look like ":1.50@/org/ayatana/NotificationItem/foo", or sometimes
     a well-known name. Only the unique ":1.NN" part identifies an owner, and
     an entry without one cannot be attributed to us. */
  const owners = new Set((listing.match(/:\d+\.\d+/g) ?? []));
  for (const owner of owners) {
    try {
      const reply = run("gdbus", [
        "call", "--session", "--dest", "org.freedesktop.DBus",
        "--object-path", "/org/freedesktop/DBus", "--method",
        "org.freedesktop.DBus.GetConnectionUnixProcessID", owner,
      ]);
      // "(uint32 4321,)"
      const found = /(\d+)/.exec(reply.replace(/uint32/g, ""));
      if (found && Number(found[1]) === pid) return true;
    } catch {
      // That name went away between the two calls. Not ours to worry about.
    }
  }
  return false;
}
