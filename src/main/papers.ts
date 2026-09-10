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
 * **The draft that is saved is `result.text`, not the stream.** The live text is
 * for the page to show while it works. `chat` already separates a model's
 * reasoning from its answer, so the returned text cannot contain thinking --
 * which is what keeps reasoning out of the record here as everywhere else.
 *
 * **And this file writes it, not the page.** The renderer used to commit the
 * finished draft, so leaving the tab mid-section discarded a minute of work into
 * an unmounted component while the request itself carried on. The section is
 * written into the record here, and `mergeDrafts` stops the page's autosave
 * racing back over it with the empty draft it still believes in.
 */

import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ipcMain, shell } from "electron";

import type { ConfigStore, EndpointSettings } from "../core/config.ts";
import { runSubagent } from "../core/llm/chat.ts";
import { citationsIn } from "../core/documents/draft.ts";
import { resolveFormat, slugName } from "../core/documents/formats.ts";
import { convert, documentsDir, writeText } from "../core/documents/office.ts";
import { assemble, assertPaperId, mergeDrafts, newPaper, type Paper } from "../core/papers/paper.ts";
import { buildSystem, buildUser, type DraftRequest } from "../core/papers/prompt.ts";
import { byNewest, idOfFile, paperFileName, parseRecord, summaryOf } from "../core/papers/store.ts";
import { makeOwnDir, OWNER_ONLY_FILE } from "../core/paths.ts";
import type { Jobs } from "./work.ts";

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
  /**
   * The lease on long work, shared with the peer reviewer.
   *
   * It also holds the live text, which is why a section drafted while the page
   * is closed is no longer lost: the buffer and the record both live out here.
   */
  jobs: Jobs;
  /**
   * A paper has just been created, and here is its id.
   *
   * Injected rather than imported, because the module that files it also reads
   * papers -- importing it here would be a cycle, and this module has
   * deliberately never known that projects exist.
   */
  onCreated?: (ref: string) => void;
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

/**
 * Read one paper, or nothing if it cannot be read.
 *
 * Exported alongside the delete because a project needs both: it assembles a
 * paper into the export folder and removes it when the project goes.
 */
export async function readPaperRecord(root: string, id: string): Promise<Paper | undefined> {
  return await readPaper(root, id);
}

/** Remove one paper. The same call the page's own Delete makes. */
export async function deletePaper(root: string, id: string): Promise<void> {
  await rm(join(root, paperFileName(assertPaperId(id))), { force: true });
}

export function installPaperIpc(deps: PaperDeps): void {
  const { jobs } = deps;

  ipcMain.handle("karen:paper-list", async () => ({
    ok: true,
    papers: await listPapers(rootOf(deps)),
  }));

  ipcMain.handle("karen:paper-create", async (_e, kind: unknown, title: unknown) => {
    const paper = newPaper({
      kind: kind === "section" ? "section" : "paper",
      title: typeof title === "string" ? title : "",
    });
    const stored = await savePaper(rootOf(deps), paper);
    deps.onCreated?.(stored.id);
    return { ok: true, paper: stored };
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
    /* Reconciled with the file, because the page is no longer the only writer:
       a section finished a moment ago is on disk and not yet in the copy this
       save was built from. */
    const merged = mergeDrafts(await readPaper(rootOf(deps), paper.id), paper);
    const stored = await savePaper(rootOf(deps), merged);
    return { ok: true, updatedAt: stored.updatedAt, paper: stored };
  });

  ipcMain.handle("karen:paper-delete", async (_e, id: unknown) => {
    await deletePaper(rootOf(deps), String(id));
    return { ok: true, papers: await listPapers(rootOf(deps)) };
  });

  ipcMain.handle("karen:paper-cancel", async (_e, id: unknown) => {
    jobs.cancel(id ? String(id) : undefined);
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
  ipcMain.handle("karen:paper-draft", async (_e, paperId: unknown, sectionId: unknown, raw: unknown) => {
    const id = String(sectionId);
    const request = raw as DraftRequest;
    if (!request || typeof request !== "object") return { ok: false, error: "Nothing to draft." };
    if (request.mode !== "refine" && !request.notes.trim()) {
      return { ok: false, error: "Write or dictate some notes for this section first." };
    }

    const paper = String(paperId ?? "");
    const signal = jobs.begin({
      kind: "paper",
      id: paper,
      title: request.paperTitle,
      steps: 1,
      label: request.sectionName,
      sectionId: id,
    });
    if (!signal) return { ok: false, error: "Karen is already working on something long." };

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
        signal,
        onDelta: (text, kind) => jobs.append(kind, text),
        onProgress: (note) => {
          if (note.startsWith("retrying")) jobs.restart();
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
      /* Committed here, not by the page. This is the line that makes leaving
         the tab mid-draft free: the record has the section whether or not
         anything is still listening. A paper that has since been deleted is not
         resurrected -- there is nothing to write into. */
      const stored = await readPaper(rootOf(deps), paper);
      const saved = stored
        ? await savePaper(rootOf(deps), {
            ...stored,
            sections: stored.sections.map((s) => (s.id === id ? { ...s, draft: text } : s)),
          })
        : undefined;
      if (saved) deps.send("karen:paper-changed", saved);

      /* Reported, never repaired. The prompt forbids citations and this checks;
         removing a fabricated marker would leave the sentence it supported
         reading as the author's own established fact, which is the more
         dangerous of the two states. documents/draft.ts made the same call. */
      return { ok: true, text, invented: citationsIn(text) };
    } catch (err) {
      const message = (err as Error).message || "The draft failed.";
      return {
        ok: false,
        error: signal.aborted ? "Stopped." : message,
      };
    } finally {
      jobs.end();
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
