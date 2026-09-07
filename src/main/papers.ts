/**
 * The paper drafter, wired to the window.
 *
 * The same split meetings and images use: [core/papers/](../core/papers/paper.ts)
 * holds the record, the prompt and the assembly and knows nothing about
 * Electron; this file owns the folder, the model call and the IPC; the renderer
 * draws.
 *
 * Two things are worth knowing before changing anything here.
 *
 * **The model is whichever one is answering.** `deps.llm` is the same resolver
 * chat and meetings use, so the paper drafter follows the model bar and there is
 * no endpoint, key or model setting anywhere in this feature. The tool this was
 * ported from carried its own base URL, its own API key in its own keyring
 * entry, and its own model list; a second copy of all that is the drift that
 * makes a privacy claim untrue.
 *
 * **The draft that is saved is `result.text`, not the stream.** The deltas are
 * for the page to show while it works. `chat` already separates a model's
 * reasoning from its answer, so the returned text cannot contain thinking --
 * which is what keeps reasoning out of the record here as everywhere else.
 */

import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ipcMain, shell } from "electron";

import type { ConfigStore, EndpointSettings } from "../core/config.ts";
import { runSubagent } from "../core/llm/chat.ts";
import { citationsIn } from "../core/documents/draft.ts";
import { resolveFormat, slugName } from "../core/documents/formats.ts";
import { convert, documentsDir, writeText } from "../core/documents/office.ts";
import { assemble, assertPaperId, newPaper, type Paper } from "../core/papers/paper.ts";
import { buildSystem, buildUser, type DraftRequest } from "../core/papers/prompt.ts";
import { byNewest, idOfFile, paperFileName, parseRecord, summaryOf } from "../core/papers/store.ts";
import { makeOwnDir, OWNER_ONLY_FILE } from "../core/paths.ts";

export interface PaperDeps {
  config: ConfigStore;
  /**
   * The model that is actually answering, resolved the way chat resolves it.
   *
   * Not `settings.llm`: with a local model loaded that field is empty, and
   * reading it directly is how meetings came to report "no LLM endpoint is
   * configured" while a model sat loaded.
   */
  llm: () => Promise<{ endpoint: EndpointSettings; apiKey?: string; label?: string }>;
  send: (channel: string, payload?: unknown) => void;
}

/** One frame of a draft in flight, as the page receives it. */
export interface PaperDelta {
  sectionId: string;
  kind: "text" | "thinking";
  text: string;
  /**
   * Start this section's text again.
   *
   * `runSubagent` retries a failed request up to three times, and an attempt
   * that died halfway has already streamed half a draft into the page. Without
   * this the retry appends to it and the author watches their section written
   * twice.
   */
  reset?: boolean;
}

function rootOf(deps: Pick<PaperDeps, "config">): string {
  return deps.config.current.papersRoot;
}

async function readPaper(root: string, id: string): Promise<Paper | undefined> {
  try {
    const raw = await readFile(join(root, paperFileName(assertPaperId(id))), "utf8");
    return parseRecord(JSON.parse(raw), id);
  } catch {
    /* Missing, unparseable, or half-written by a sync client. The list already
       skips what it cannot read; opening one directly says so instead. */
    return undefined;
  }
}

/**
 * Write the record, via a temporary name.
 *
 * The rename is what makes a save atomic: a crash between opening the file and
 * finishing it would otherwise truncate a paper somebody has been writing for a
 * week, and this is autosaved on a timer while they type.
 */
async function savePaper(root: string, paper: Paper): Promise<Paper> {
  await makeOwnDir(root);
  const stored: Paper = { ...paper, updatedAt: new Date().toISOString() };
  const target = join(root, paperFileName(assertPaperId(paper.id)));
  const temp = `${target}.partial`;
  await writeFile(temp, JSON.stringify(stored, null, 2), { mode: OWNER_ONLY_FILE });
  await rename(temp, target);
  return stored;
}

export async function listPapers(root: string): Promise<ReturnType<typeof summaryOf>[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const id = idOfFile(name);
    if (!id) continue;
    const paper = await readPaper(root, id);
    if (paper) out.push(summaryOf(paper));
  }
  return out.sort(byNewest);
}

export function installPaperIpc(deps: PaperDeps): void {
  const { send } = deps;
  /* One draft at a time, deliberately. Two sections drafting at once on a local
     model is the out-of-memory failure meetings avoids by transcribing
     serially, and a second Draft button pressed while the first is running is
     far more often a double click than an intention. */
  let running: AbortController | undefined;

  ipcMain.handle("karen:paper-list", async () => ({
    ok: true,
    papers: await listPapers(rootOf(deps)),
  }));

  ipcMain.handle("karen:paper-create", async (_e, kind: unknown, title: unknown) => {
    const paper = newPaper({
      kind: kind === "section" ? "section" : "paper",
      title: typeof title === "string" ? title : "",
    });
    return { ok: true, paper: await savePaper(rootOf(deps), paper) };
  });

  ipcMain.handle("karen:paper-open", async (_e, id: unknown) => {
    const paper = await readPaper(rootOf(deps), String(id));
    return paper
      ? { ok: true, paper }
      : { ok: false, error: "That paper could not be read. It may have been moved or deleted." };
  });

  ipcMain.handle("karen:paper-save", async (_e, raw: unknown) => {
    const id = (raw as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string") return { ok: false, error: "That paper has no id." };
    /* Rebuilt field by field on the way in, not trusted as it arrives. The
       window is sandboxed and this object is about to become a file. */
    const paper = parseRecord(raw, assertPaperId(id));
    if (!paper) return { ok: false, error: "That paper could not be saved." };
    const stored = await savePaper(rootOf(deps), paper);
    return { ok: true, updatedAt: stored.updatedAt };
  });

  ipcMain.handle("karen:paper-delete", async (_e, id: unknown) => {
    await rm(join(rootOf(deps), paperFileName(assertPaperId(String(id)))), { force: true });
    return { ok: true, papers: await listPapers(rootOf(deps)) };
  });

  ipcMain.handle("karen:paper-cancel", async () => {
    running?.abort();
    return { ok: true };
  });

  /**
   * Draft or refine one section.
   *
   * The request is built by the page and sent whole, which is what makes the
   * preview dialog honest: it renders these same two functions over the same
   * object, so "exactly what will be sent" is the thing that is sent rather
   * than a reconstruction of it.
   */
  ipcMain.handle("karen:paper-draft", async (_e, sectionId: unknown, raw: unknown) => {
    if (running) return { ok: false, error: "Karen is already drafting a section." };
    const id = String(sectionId);
    const request = raw as DraftRequest;
    if (!request || typeof request !== "object") return { ok: false, error: "Nothing to draft." };
    if (request.mode !== "refine" && !request.notes.trim()) {
      return { ok: false, error: "Write or dictate some notes for this section first." };
    }

    const controller = new AbortController();
    running = controller;
    try {
      const resolved = await deps.llm();
      const result = await runSubagent({
        /* The endpoint the resolver returned already names the model; this is
           only what the result reports it ran on. Empty means "do not
           override what is on the endpoint", which is exactly right here. */
        model: resolved.endpoint.model ?? "",
        endpoint: resolved.endpoint,
        ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
        system: buildSystem(request),
        prompt: buildUser(request),
        signal: controller.signal,
        onDelta: (text, kind) => send("karen:paper-delta", { sectionId: id, kind, text } satisfies PaperDelta),
        onProgress: (note) => {
          if (!note.startsWith("retrying")) return;
          send("karen:paper-delta", { sectionId: id, kind: "text", text: "", reset: true } satisfies PaperDelta);
        },
      });
      const text = result.text.trim();
      if (!text) {
        return {
          ok: false,
          error:
            "The model returned nothing usable — only its own reasoning, or an empty reply. " +
            "Try again, or choose a different model on the Models page.",
        };
      }
      /* Reported, never repaired. The prompt forbids citations and this checks;
         removing a fabricated marker would leave the sentence it supported
         reading as the author's own established fact, which is the more
         dangerous of the two states. documents/draft.ts made the same call. */
      return { ok: true, text, invented: citationsIn(text) };
    } catch (err) {
      const message = (err as Error).message || "The draft failed.";
      return {
        ok: false,
        error: controller.signal.aborted ? "Stopped." : message,
      };
    } finally {
      running = undefined;
    }
  });

  ipcMain.handle("karen:paper-export", async (_e, id: unknown, formatName: unknown) => {
    const paper = await readPaper(rootOf(deps), String(id));
    if (!paper) return { ok: false, error: "That paper could not be read." };
    const format = resolveFormat(String(formatName));
    if (!format) return { ok: false, error: `Karen cannot write ${String(formatName)} files.` };

    const dir = documentsDir();
    /* Markdown goes to disk first because the converters read files, not
       stdin -- the same order write_document uses. */
    const source = join(dir, slugName(paper.title, "md"));
    await writeText(source, assemble(paper));
    if (format.ext === "md") return { ok: true, path: source };
    try {
      return { ok: true, path: await convert(source, format, dir) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("karen:paper-reveal", async (_e, path: unknown) => {
    shell.showItemInFolder(String(path));
    return { ok: true };
  });
}
