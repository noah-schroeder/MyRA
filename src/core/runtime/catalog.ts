/**
 * The models Lemonade knows about, and what each one is for.
 *
 * The daemon's `/models` endpoint lists only what is registered or already
 * downloaded -- three things on a fresh machine. The catalogue proper is a file
 * shipped inside the install, `resources/server_models.json`, and it is worth
 * reading directly for two reasons: it needs no network, and it carries the two
 * fields the daemon's own API does not return.
 *
 *   - **`size`**, in gigabytes. Without it "will this fit in your VRAM" has no
 *     input, and that guidance is most of what makes a model list usable by
 *     someone who does not know what a quant is.
 *   - **`labels`**, which is what separates a chat model from a speech model
 *     from an image model. Lemonade serves all of them through one API, so the
 *     labels are the only thing that says which is which.
 *
 * 228 entries across 15 engines at the time of writing, which is why this is
 * grouped and filtered rather than listed.
 */

/** One model as the catalogue describes it. */
export interface CatalogEntry {
  id: string;
  /** The engine that runs it: `llamacpp`, `whispercpp`, `kokoro`, `sd-cpp`… */
  recipe: string;
  /** `chat`, `reasoning`, `transcription`, `tts`, `image`, `vision`… */
  labels: string[];
  /** Download size in bytes, converted from the catalogue's gigabytes. */
  sizeBytes?: number | undefined;
  /** Upstream's own shortlist, which is a better default than alphabetical. */
  suggested: boolean;
}

type Obj = Record<string, unknown>;

/**
 * What each label means to someone choosing a model.
 *
 * Karen's users are academics, not people shopping for inference engines, so
 * the grouping is by what a model DOES rather than by which engine runs it.
 */
export const LABEL_GROUPS: { id: string; title: string; labels: string[] }[] = [
  { id: "chat", title: "Chat and writing", labels: ["chat", "reasoning", "coding"] },
  { id: "vision", title: "Reading images and documents", labels: ["vision", "omni"] },
  { id: "speech", title: "Transcription", labels: ["transcription", "realtime-transcription"] },
  { id: "voice", title: "Speech synthesis", labels: ["tts"] },
  { id: "image", title: "Image generation", labels: ["image"] },
  { id: "embedding", title: "Search and embeddings", labels: ["embedding", "reranking"] },
];

export function parseCatalog(raw: unknown): CatalogEntry[] {
  if (!raw || typeof raw !== "object") return [];
  const out: CatalogEntry[] = [];
  for (const [id, value] of Object.entries(raw as Obj)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Obj;
    const recipe = typeof entry["recipe"] === "string" ? entry["recipe"] : "";
    if (!recipe) continue;
    const size = entry["size"];
    const labels = Array.isArray(entry["labels"])
      ? entry["labels"].filter((l): l is string => typeof l === "string")
      : [];
    out.push({
      id,
      recipe,
      labels,
      suggested: entry["suggested"] === true,
      ...(typeof size === "number" && size > 0
        ? { sizeBytes: Math.round(size * 1024 ** 3) }
        : {}),
    });
  }
  return out;
}

/** The group a model belongs in, or undefined when it fits none of them. */
export function groupOf(entry: CatalogEntry): string | undefined {
  for (const group of LABEL_GROUPS) {
    if (entry.labels.some((l) => group.labels.includes(l))) return group.id;
  }
  return undefined;
}

/**
 * Order a group for display: upstream's suggestions first, then smallest.
 *
 * Size ascending rather than descending because the constraint people actually
 * hit is memory, and the smallest thing that does the job is usually the right
 * answer on a laptop.
 */
export function sortForDisplay(entries: CatalogEntry[]): CatalogEntry[] {
  return [...entries].sort((a, b) => {
    if (a.suggested !== b.suggested) return a.suggested ? -1 : 1;
    return (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity);
  });
}

/** Split the catalogue into the groups the UI shows, dropping empty ones. */
export function groupCatalog(
  entries: CatalogEntry[],
): { id: string; title: string; entries: CatalogEntry[] }[] {
  return LABEL_GROUPS.map((group) => ({
    id: group.id,
    title: group.title,
    entries: sortForDisplay(entries.filter((e) => groupOf(e) === group.id)),
  })).filter((g) => g.entries.length);
}

/** Every engine named by the catalogue, so backends can be offered for each. */
export function recipesIn(entries: CatalogEntry[]): string[] {
  return [...new Set(entries.map((e) => e.recipe))].sort();
}
