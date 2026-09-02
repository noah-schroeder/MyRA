/**
 * The literature databases this build searches, by name.
 *
 * Its own module, with no imports, for two reasons. It has to be readable from
 * the renderer, and the provider list is not -- that file reaches the network
 * clients, which reach the config reader, which reads the filesystem, none of
 * which belongs in a browser bundle. And it has to be the SAME list the search
 * actually uses, or the bar would be naming databases nobody queried.
 *
 * The second half is what the test enforces: every scholarly provider's label
 * appears here, and nothing here is missing from the providers. A database
 * added or dropped shows up on the bar, or the suite fails.
 */

/** In the order they are asked, which is the order the bar names them. */
export const SCHOLARLY_DATABASES = ["OpenAlex", "arXiv"] as const;

/** "OpenAlex · arXiv" — short enough to sit above three buttons. */
export function databaseLabel(): string {
  return SCHOLARLY_DATABASES.join(" · ");
}
