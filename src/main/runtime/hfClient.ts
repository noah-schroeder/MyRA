/**
 * The one place Karen talks to Hugging Face itself.
 *
 * Everything else about a model still goes through Lemonade: the file list for
 * a repository, the download, the load. This module only asks the registry
 * what it holds, because that is the one question Lemonade's own search cannot
 * express -- no publisher filter, no model kind, fifty results matched on
 * names alone.
 *
 * It is deliberately narrow. The host is a constant, the path is a constant,
 * and the only thing a caller may influence is the query string, which is
 * built by `browseParams` from a typed object rather than passed through. A
 * renderer cannot reach this except through one IPC channel that takes those
 * same fields, so there is no shape of input that turns this into a general
 * fetch.
 */

import { browseParams, parseModels, type BrowseQuery, type HfModel } from "../../core/runtime/hfBrowse.ts";

/** Fixed. Not configurable, and not taken from anything a caller supplies. */
const HOST = "https://huggingface.co";
const PATH = "/api/models";

/** Long enough for a hundred rows on a slow connection, short enough to fail. */
const TIMEOUT_MS = 20_000;

export interface BrowseResult {
  models: HfModel[];
  /** What was actually asked, so the UI can say it rather than guess. */
  url: string;
}

export async function browseHuggingFace(query: BrowseQuery): Promise<BrowseResult> {
  const params = browseParams(query);
  const url = `${HOST}${PATH}?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        /* Named honestly. The registry sees a request either way; telling it
           which application is asking is ordinary manners and costs nothing
           the request itself did not already reveal. No token is attached --
           this endpoint is public, and sending one would tie a browse to an
           account. */
        "user-agent": "Karen (local research assistant)",
        accept: "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(
        res.status === 429
          ? "Hugging Face is rate-limiting this machine. Wait a minute and try again."
          : `Hugging Face returned ${String(res.status)}.`,
      );
    }
    return { models: parseModels(await res.json()), url };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error("Hugging Face did not answer within 20 seconds.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
