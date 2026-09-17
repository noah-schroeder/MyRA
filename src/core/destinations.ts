/**
 * Every host this application can contact, in one place.
 *
 * The privacy claim in Settings is rendered from this table, so the claim and
 * the code cannot drift apart by being edited separately: `test/destinations.test.ts`
 * scans the source for URL literals and fails if it finds a host that is not
 * listed here. Adding a new outbound call therefore means adding a line here
 * and saying, in plain English, what it sends.
 *
 * Two things are deliberately NOT in this table because they are not fixed
 * hosts:
 *
 *   - the endpoints the user configures (chat, transcription, embeddings),
 *     which are wherever they point them and are listed separately in the UI
 *     from the settings themselves;
 *   - the arbitrary pages and PDFs a research run decides to read, which is
 *     the whole point of a research run and is described as such.
 *
 * Nothing here is contacted on a timer. Every entry names the button.
 */

export interface Destination {
  /** Exact hostname, or a `.suffix` matching that domain and its subdomains. */
  host: string;
  /** What causes the request. Always a thing the user did. */
  when: string;
  /** What the request carries beyond the fact that it was made. */
  sends: string;
}

export const DESTINATIONS: readonly Destination[] = [
  {
    host: "api.openalex.org",
    when: "You search the literature, or a research run does",
    sends: "The search terms",
  },
  {
    host: "export.arxiv.org",
    when: "You search the literature, or a research run does",
    sends: "The search terms",
  },
  {
    host: "api.semanticscholar.org",
    when: "A paper has already been found and has no open-access link yet",
    sends: "That paper's DOI",
  },
  {
    host: "eutils.ncbi.nlm.nih.gov",
    when: "PubMed is one of the databases chosen for a search, and you have added your own NCBI key",
    sends: "The search terms, and that key",
  },
  {
    host: "pubmed.ncbi.nlm.nih.gov",
    when: "A PubMed result with no DOI is opened as its landing page",
    sends: "Nothing but the request",
  },
  {
    host: "www.ncbi.nlm.nih.gov",
    when: "You press \"Get a free key\" for PubMed in Settings → Database keys",
    sends: "Nothing but the request",
  },
  {
    host: "api.core.ac.uk",
    when: "CORE is one of the databases chosen for a search, and you have added your own CORE key",
    sends: "The search terms, and that key",
  },
  {
    host: "core.ac.uk",
    when: "A CORE result with no DOI or readable copy is opened as its landing page, or you press " +
      "\"Get a free key\" for CORE in Settings → Database keys",
    sends: "Nothing but the request",
  },
  {
    host: "doi.org",
    when: "A DOI is resolved to the page it points at",
    sends: "The DOI",
  },
  {
    host: "api.github.com",
    when: "MyRA sets up its local runtime or document tools, or you press Check for engine updates " +
      "or Check for updates in Settings → About",
    sends: "Nothing but the request",
  },
  {
    host: "github.com",
    when: "An engine build, the Lemonade daemon, or pandoc is downloaded",
    sends: "Nothing but the request",
  },
  {
    host: ".githubusercontent.com",
    when: "GitHub redirects one of those downloads to its own file host",
    sends: "Nothing but the request",
  },
  {
    host: "ghcr.io",
    when: "You install the CUDA runtime on Linux, which upstream publishes only as a container image",
    sends: "Nothing but the request",
  },
  {
    host: ".ghcr.io",
    when: "GitHub redirects that download to its own blob host",
    sends: "Nothing but the request",
  },
  {
    host: "huggingface.co",
    when: "You search for or download a model",
    sends: "The search terms you type",
  },
  {
    host: ".hf.co",
    when: "A model download is redirected to HuggingFace's CDN",
    sends: "Nothing but the request",
  },
] as const;

/** Loopback and this machine, which are not "leaving" by any definition. */
const LOCAL = /^(127\.\d+\.\d+\.\d+|::1|0:0:0:0:0:0:0:1|localhost|0\.0\.0\.0)$/i;

/**
 * The one place the app decides whether an address is off this machine.
 *
 * One place on purpose: this line is what the privacy report draws and what
 * decides whether choosing a model warns the user, and two functions answering
 * it would eventually answer it differently.
 *
 * Brackets are stripped because every caller gets its host from
 * `new URL(...).hostname`, which returns IPv6 literals bracketed -- "[::1]",
 * never "::1". Without this, the one loopback address a person is most likely
 * to type by hand read as remote.
 */
export function isLocalHost(host: string): boolean {
  return LOCAL.test(host.replace(/^\[|\]$/g, ""));
}

export function describes(host: string): Destination | undefined {
  const lower = host.toLowerCase();
  return DESTINATIONS.find((d) =>
    d.host.startsWith(".") ? lower === d.host.slice(1) || lower.endsWith(d.host) : lower === d.host,
  );
}
