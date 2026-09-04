/**
 * The one place Karen talks to Hugging Face itself.
 *
 * The download and the load still go through Lemonade. What is asked here is
 * the three questions Lemonade cannot answer: what the registry holds (its own
 * search has no publisher filter, no model kind, and fifty results matched on
 * names alone), what is in one repository, and what its model card says.
 *
 * It is deliberately narrow. The host is a constant, the paths are constants,
 * and the only things a caller may influence are a query string built by
 * `browseParams` from a typed object and a repository id checked against
 * `org/name` before it is put in a path. A renderer cannot reach any of this
 * except through IPC channels that take those same fields, so there is no
 * shape of input that turns this into a general fetch.
 */

import {
  browseParams, mergeSorted, parseModels, parseRepoDetail,
  type BrowseQuery, type HfModel, type RepoDetail,
} from "../../core/runtime/hfBrowse.ts";
import { CARD_LIMIT } from "../../core/runtime/modelCard.ts";

/** Fixed. Not configurable, and not taken from anything a caller supplies. */
const HOST = "https://huggingface.co";
const PATH = "/api/models";

/* Named honestly. The registry sees a request either way; telling it which
   application is asking is ordinary manners and costs nothing the request
   itself did not already reveal. No token is ever attached -- these endpoints
   are public, and sending one would tie a browse to an account. */
const AGENT = "Karen (local research assistant)";

/** Long enough for a hundred rows on a slow connection, short enough to fail. */
const TIMEOUT_MS = 20_000;

export interface BrowseResult {
  models: HfModel[];
  /** What was actually asked, so the UI can say it rather than guess. */
  url: string;
}

export async function browseHuggingFace(query: BrowseQuery): Promise<BrowseResult> {
  /*
   * One request per publisher, because the registry takes one `author` and
   * answers `author=a&author=b` with nothing at all. Run together rather than
   * in turn: four publishers in sequence is four round trips of latency for a
   * list that arrives all at once anyway.
   */
  const authors = query.authors?.length ? query.authors : [undefined];
  const pages = await Promise.all(
    authors.map(async (author) => {
      const params = browseParams({ ...query, ...(author ? { author } : {}) });
      return { url: `${HOST}${PATH}?${params.toString()}`, models: await getModels(`${HOST}${PATH}?${params.toString()}`) };
    }),
  );

  return {
    models:
      pages.length === 1
        ? (pages[0]?.models ?? [])
        : mergeSorted(pages.map((p) => p.models), query.sort ?? "downloads"),
    url: pages.map((p) => p.url).join(" + "),
  };
}

async function getModels(url: string): Promise<HfModel[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": AGENT, accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(
        res.status === 429
          ? "Hugging Face is rate-limiting this machine. Wait a minute and try again."
          : `Hugging Face returned ${String(res.status)}.`,
      );
    }
    return parseModels(await res.json());
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error("Hugging Face did not answer within 20 seconds.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One repository, in a single request.
 *
 * Lemonade's `/pull/variants` cannot answer this for anything but GGUF, ONNX
 * RyzenAI and its own Omni collections -- asked about `stabilityai/sd-turbo` it
 * returns a 500 naming those three. Image, speech and voice models therefore
 * have no file list at all unless it comes from the registry, which is what
 * this is for.
 *
 * `blobs=true` is what makes the sizes appear; without it the sibling list is
 * filenames only, and a download with no size next to it is a download nobody
 * should be asked to agree to. The same response carries the licence, the base
 * model and the GGUF header -- see `parseRepoDetail`, which is where the choice
 * to keep them rather than discard them lives.
 */
export async function repoDetail(repo: string): Promise<RepoDetail> {
  const id = validRepo(repo);
  const body = await getJson(`${HOST}${PATH}/${id}?blobs=true`, id);
  return parseRepoDetail(body, id);
}

/**
 * The model card itself.
 *
 * Not on the API host: the JSON endpoint returns the card's front matter as
 * `cardData` and never its prose, so the readable half has to come from the
 * file. `raw` rather than `resolve`, because `resolve` redirects large files to
 * the CDN and a README is neither large nor worth a second hop.
 *
 * A repository with no README is not an error. Plenty of GGUF builds ship
 * without one, and reporting "Hugging Face returned 404" for a model that is
 * perfectly downloadable would send somebody looking for a fault that is not
 * there.
 */
export async function repoCard(repo: string): Promise<string | undefined> {
  const id = validRepo(repo);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${HOST}/${id}/raw/main/README.md`, {
      signal: controller.signal,
      headers: { "user-agent": AGENT, accept: "text/plain, text/markdown, */*" },
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`Hugging Face returned ${String(res.status)} for ${id}'s model card.`);
    const text = await res.text();
    /* Cut here rather than in the window: the cap exists so that a
       pathological card cannot be pushed through IPC, and a limit applied
       after the transfer would not be that. */
    return text.length > CARD_LIMIT * 2 ? text.slice(0, CARD_LIMIT * 2) : text;
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error("Hugging Face did not answer within 20 seconds.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* The repository id goes into a path, so it is checked rather than trusted:
   `org/name` and nothing else, which also rules out `..` and any absolute or
   scheme-bearing string. */
function validRepo(repo: string): string {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    throw new Error(`Not a repository id: ${repo}`);
  }
  return repo;
}

async function getJson(url: string, repo: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": AGENT, accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(
        res.status === 404
          ? `Hugging Face has no repository called ${repo}.`
          : `Hugging Face returned ${String(res.status)} for ${repo}.`,
      );
    }
    return await res.json();
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error("Hugging Face did not answer within 20 seconds.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
