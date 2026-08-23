/**
 * Rendering GNOME's key-binding syntax for humans.
 *
 * Separate from the component so it can be tested directly: Node strips types
 * from .ts but does not compile JSX, so anything importable by a test has to
 * live outside the .tsx.
 */

/** "<Super>d" is how GNOME stores it, not how a person reads it. */
export function prettyBinding(binding: string): string {
  const parts: string[] = [];
  let rest = binding;
  const mods: [RegExp, string][] = [
    [/<Super>/gi, "Super"], [/<Ctrl>|<Primary>|<Control>/gi, "Ctrl"],
    [/<Alt>/gi, "Alt"], [/<Shift>/gi, "Shift"],
  ];
  for (const [re, label] of mods) {
    if (re.test(rest)) {
      parts.push(label);
      rest = rest.replace(re, "");
    }
  }
  const key = rest.trim();
  if (key) parts.push(key.length === 1 ? key.toUpperCase() : key);
  return parts.join(" + ");
}
