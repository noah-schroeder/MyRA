/**
 * The tray icon, embedded rather than loaded from a file.
 *
 * `electron-builder.yml` packages only `out/**` and `package.json`, so
 * `build/icons/` -- which is `buildResources`, used at package time to make the
 * .deb's own icons -- does not exist inside the installed app. An icon read
 * from there works in development and is missing in production, which is the
 * worst of both.
 *
 * Base64 keeps one source of truth for the bytes, works identically in
 * development and in the package, and needs no change to what gets shipped.
 * Regenerate from `build/icons/32x32.png` if the mark ever changes.
 */

const PNG_32 =
  "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";

export const TRAY_ICON_PNG = PNG_32;
