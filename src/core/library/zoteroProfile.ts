/**
 * Asking Zotero where its library is, instead of guessing.
 *
 * The guesses in `zoteroDb.ts` cover Zotero's defaults, and defaults are
 * exactly what a researcher with a large library does not have: a Zotero data
 * directory is routinely moved to a second disk, an encrypted volume, or a
 * synced folder, and none of those are anywhere a list of candidates could
 * name. When that has happened, every candidate misses, the scan misses, and
 * Karen reports "Zotero does not appear to be reachable" — the message for a
 * completely different problem — to somebody whose library is fine.
 *
 * Zotero writes the answer down. It is a Firefox-derived application, so it
 * keeps a profile directory with a `prefs.js` in it, and a data directory that
 * is not the default appears there as `extensions.zotero.dataDir`. Reading
 * that is not a heuristic: it is the same value Zotero itself opens on
 * startup.
 *
 * Everything here is pure — parsing text, and naming directories. The reading
 * lives in the main process, so this can be tested against real `prefs.js` and
 * `profiles.ini` content with no Zotero installed anywhere.
 */

/** What Zotero calls its preference file, inherited from Firefox. */
export const PREFS_FILE = "prefs.js";
export const PROFILES_INI = "profiles.ini";

/** The preference that names a data directory that is not the default. */
const DATA_DIR_PREF = "extensions.zotero.dataDir";

/**
 * The switch that says whether the directory above is in use.
 *
 * Zotero keeps the last custom path even after the user moves back to the
 * default, so the path alone is not an answer: `useDataDir` false means "that
 * is where it used to be". Honouring the stale path would point Karen at a
 * library the user has stopped using — which is worse than not finding one,
 * because it looks like it worked.
 */
const USE_DATA_DIR_PREF = "extensions.zotero.useDataDir";

/**
 * Where the profile directories live, per platform.
 *
 * A sandboxed Zotero has its own copy of the same layout under its own home,
 * which is why the Flatpak and Snap paths are here as well as in the data
 * directory candidates: the profile moves with the sandbox, and it is the
 * profile that says where the data went.
 */
export function profileRoots(home: string, env: Record<string, string | undefined> = {}): string[] {
  const join = (...parts: string[]): string => parts.join("/");
  const roots = [
    // Linux, native.
    join(home, ".zotero", "zotero"),
    // Flatpak: $HOME inside the sandbox is the per-app data directory.
    join(home, ".var", "app", "org.zotero.Zotero", "data", ".zotero", "zotero"),
    join(home, ".var", "app", "org.zotero.Zotero", ".zotero", "zotero"),
    /* Snap, under both names it has been published as and both homes it
       uses: `current` is $HOME inside the confinement and is where a dotfile
       actually lands, `common` is the version-independent one. Listing only
       `common` would miss the ordinary case. */
    join(home, "snap", "zotero-snap", "current", ".zotero", "zotero"),
    join(home, "snap", "zotero-snap", "common", ".zotero", "zotero"),
    join(home, "snap", "zotero", "current", ".zotero", "zotero"),
    join(home, "snap", "zotero", "common", ".zotero", "zotero"),
    // macOS.
    join(home, "Library", "Application Support", "Zotero"),
  ];
  /* Windows. Karen is a Linux application today, but this file is the one
     place that would have to change first, and leaving it out would make the
     omission invisible rather than deliberate. */
  const appData = env["APPDATA"];
  roots.push(appData ? join(appData, "Zotero", "Zotero") : join(home, "AppData", "Roaming", "Zotero", "Zotero"));
  return roots;
}

/**
 * The profile directories named by a `profiles.ini`, the default one first.
 *
 * Zotero supports several profiles and most people have exactly one, so the
 * order matters mainly for the person who has two — and for them, the default
 * is the library they are actually looking at.
 *
 * Deliberately forgiving about the file: it is INI, it is written by another
 * program, and a section this does not understand should cost that section
 * rather than the whole lookup.
 */
export function parseProfilesIni(text: string, root: string): string[] {
  const entries: { rank: number; path: string }[] = [];
  let section = "";
  let fields: Record<string, string> = {};

  const flush = (): void => {
    if (!section.toLowerCase().startsWith("profile")) return;
    const raw = (fields["path"] ?? "").trim();
    if (!raw) return;
    // profiles.ini uses forward slashes on every platform, including Windows.
    const relative = (fields["isrelative"] ?? "1").trim() !== "0";
    const path = relative ? `${root}/${raw.replace(/\\/g, "/")}` : raw.replace(/\\/g, "/");
    entries.push({ rank: (fields["default"] ?? "0").trim() === "1" ? 0 : 1, path });
  };

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) {
      flush();
      section = trimmed.slice(1, trimmed.indexOf("]") === -1 ? undefined : trimmed.indexOf("]"));
      fields = {};
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    fields[trimmed.slice(0, eq).trim().toLowerCase()] = trimmed.slice(eq + 1);
  }
  flush();

  /* Stable within a rank: two non-default profiles keep the order the file
     listed them in, which is the order Zotero created them. */
  const seen = new Set<string>();
  return entries
    .sort((a, b) => a.rank - b.rank)
    .map((e) => e.path)
    .filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
}

/**
 * The profile folder names to try when there is no `profiles.ini` to read.
 *
 * A hand-copied profile, or one from a Zotero that has not written the ini
 * yet, still has the conventional name. Globs rather than a literal because
 * the prefix is random: `abc12def.default`.
 */
export const PROFILE_PATTERNS: readonly RegExp[] = [/\.default$/, /\.default-/];

export function looksLikeProfileDir(name: string): boolean {
  return PROFILE_PATTERNS.some((p) => p.test(name));
}

/**
 * One `user_pref` line's value, as JavaScript wrote it.
 *
 * prefs.js is JavaScript source, so a Windows path arrives with its
 * backslashes doubled and the occasional `é` in a name. JSON parsing
 * handles both and refuses anything malformed, which is the right answer for a
 * file another program owns.
 */
function prefValue(text: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`user_pref\\(\\s*["']${escaped}["']\\s*,\\s*([^)]*)\\)`).exec(text);
  if (!found) return undefined;
  const raw = found[1]!.trim();
  if (raw.startsWith('"')) {
    try {
      return String(JSON.parse(raw));
    } catch {
      /* Single quotes, or an escape JSON does not accept. Strip the quotes and
         undo the one escape that actually appears in these files rather than
         throwing away a perfectly readable path. */
      return raw.slice(1, -1).replace(/\\\\/g, "\\").replace(/\\"/g, '"');
    }
  }
  if (raw.startsWith("'")) return raw.slice(1, -1);
  return raw;
}

/**
 * The data directory this profile is set to use, if it is not the default.
 *
 * Undefined means "Zotero is using its default location", which is what the
 * candidate list is for — not that anything went wrong.
 */
export function dataDirFromPrefs(text: string): string | undefined {
  if (prefValue(text, USE_DATA_DIR_PREF) === "false") return undefined;
  const dir = prefValue(text, DATA_DIR_PREF)?.trim();
  return dir ? dir : undefined;
}
