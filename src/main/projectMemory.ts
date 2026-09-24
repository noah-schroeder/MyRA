/**
 * Growing a project's memory: the setup chat, the "update from this chat"
 * button, and the pass every turn runs before its reply to do the same thing
 * on its own.
 *
 * The IPC wiring belongs here for the reason [projects.ts](./projects.ts)'s
 * does: nothing in [core/projects/](../core/projects/memory.ts) may import
 * `electron`, so the part that reads Settings, resolves a model and pops a
 * dialog lives in main. `runProjectSetup` and `notesBeforeReply` still import
 * only pure functions from core -- `runSubagent` and the dialog callbacks are
 * the only side effects either one performs.
 */

import { ipcMain } from "electron";

import type { ConfigStore, EndpointSettings } from "../core/config.ts";
import type { Session } from "../core/sessions.ts";
import { runSubagent } from "../core/llm/chat.ts";
import type { TurnProgress } from "../core/llm/progress.ts";
import type { Choice } from "../core/research/questions.ts";
import {
  addItems, editItem, fieldsToItems, itemsToFields, markSetupDone, removeItem, setAuto,
  type MemoryFormField, type MemorySlot, type NewItem, type ProjectMemory,
} from "../core/projects/memory.ts";
import {
  buildOffersPrompt, buildTaskQuestionsPrompt, buildTaskResultPrompt, FIXED_TASKS, parseOffers,
  parseTaskQuestions, parseTaskResult, SETUP_GREETING, type AnsweredQuestion, type Task,
} from "../core/projects/intake.ts";
import {
  buildUpdatePrompt, groundProposals, notePass, parseProposals, type NotePass,
} from "../core/projects/memoryUpdate.ts";
import { readMemory, writeMemory } from "./memoryStore.ts";

/* ------------------------------------------------------------------ *
 * What this needs from the app                                       *
 * ------------------------------------------------------------------ */

export interface MemoryUi {
  choose(choice: Choice): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  form(
    title: string,
    message: string | undefined,
    fields: readonly MemoryFormField[],
  ): Promise<Record<string, string> | undefined>;
}

export interface MemoryDeps {
  config: ConfigStore;
  send: (channel: string, payload?: unknown) => void;
  /** Resolved the way the chat turn resolves it -- see papers.ts's own note on why not settings.llm directly. */
  llm: () => Promise<{
    endpoint: EndpointSettings;
    apiKey?: string;
    /** The reasoning switch this model takes, the one the chat turn sends. */
    extra?: Record<string, unknown>;
    /** Whether the endpoint is the bundled runtime -- see EndpointResolution in index.ts. */
    promptProgress?: boolean;
  }>;
  /** The conversation "update from this chat" reads -- always whichever one is open. */
  currentSession: () => Session;
  ui: MemoryUi;
}

let deps: MemoryDeps | undefined;

export function setMemoryHost(installed: MemoryDeps | undefined): void {
  deps = installed;
}

function host(): MemoryDeps {
  if (!deps) throw new Error("Project memory is not available: the app has not attached its host.");
  return deps;
}

/**
 * Where the setup chat shows what it is doing, all of it on the one reply the
 * user is watching.
 *
 * `say` is the narrative and is kept as the conversation's message. `think`
 * is the model's reasoning as it arrives and is never kept -- the same rule
 * an ordinary turn follows, since reasoning is workings, not an answer.
 * `progress` feeds the status row under the thread.
 */
export interface SetupOutput {
  say: (delta: string) => void;
  think: (delta: string) => void;
  progress: (progress: TurnProgress) => void;
}

/**
 * One model call. With `live`, it streams: the reasoning is shown and the
 * reply's progress reported, which is the difference between a setup step the
 * user can watch and two silent minutes spent writing JSON nobody sees. The
 * JSON itself is never shown -- only `text` is parsed, and it is parsed, not
 * printed.
 */
async function ask(
  prompt: string,
  signal?: AbortSignal,
  live?: SetupOutput,
  opts: { reasoning?: boolean } = {},
): Promise<string> {
  const { llm } = host();
  live?.progress({ phase: "waiting" });
  const resolved = await llm();
  const { text } = await runSubagent({
    model: resolved.endpoint.model ?? "",
    prompt,
    endpoint: resolved.endpoint,
    ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
    ...(signal ? { signal } : {}),
    ...((live || opts.reasoning) && resolved.extra ? { extra: resolved.extra } : {}),
    ...(live
      ? {
          onDelta: (delta: string, kind: "text" | "thinking") => {
            if (kind === "thinking") live.think(delta);
          },
          onStreamProgress: live.progress,
          ...(resolved.promptProgress ? { promptProgress: true } : {}),
        }
      : {}),
  });
  return text;
}

/* ------------------------------------------------------------------ *
 * Setup: the first chat in a research project                        *
 * ------------------------------------------------------------------ */

export { SETUP_GREETING };

/**
 * Run the whole setup chat, narrating as it goes.
 *
 * `out.say` receives DELTAS, the same shape an ordinary reply's text events are --
 * every call here joins the one growing reply the user is already watching,
 * the way a turn that thinks and then answers is still one bubble. Nothing
 * here calls a registry tool; the loop this replaces never runs, which is the
 * whole point (see systemPrompt.md... `documents/draft.ts`'s header: "code
 * runs the setup, not the model").
 *
 * Every model call is wrapped so a flaky or absent model degrades the wizard
 * rather than stranding the project in `setup: "pending"` forever -- the same
 * floor `parseOffers`'s own fallback gives a small model that returns junk.
 */
export async function runProjectSetup(
  projectId: string,
  description: string,
  out: SetupOutput,
  signal?: AbortSignal,
): Promise<ProjectMemory> {
  let memory = await readMemory(projectId);
  const ui = asking(host().ui, out);
  const { say } = out;

  say("Thanks. Let me see what's worth noting here.");

  const draft = await (async () => {
    try {
      return parseOffers(await ask(buildOffersPrompt(description), signal, out));
    } catch {
      return { items: [] as NewItem[], offers: [...FIXED_TASKS] };
    }
  })();

  if (draft.items.length) {
    const approved = await review(ui, "What I noticed", draft.items);
    if (approved.length) {
      memory = addItems(memory, approved, "setup");
      await writeMemory(projectId, memory);
      say(` Saved ${approved.length} note${approved.length === 1 ? "" : "s"} from what you said.`);
    }
  }

  if (!draft.offers.length) {
    memory = markSetupDone(memory);
    await writeMemory(projectId, memory);
    say("\n\nThat's everything for now -- I'll keep building on these notes as we go.");
    return memory;
  }

  const optionLabels = draft.offers.map((o) => (o.why ? `${o.label} — ${o.why}` : o.label));
  say("\n\nWant help with any of these now?");
  const chosenAnswer = await ui.choose({
    title: "Want help with any of these now?",
    options: optionLabels,
    multi: true,
  });

  const chosen = draft.offers.filter((_, i) => (chosenAnswer ?? "").split("; ").includes(optionLabels[i]!));
  if (!chosen.length) {
    memory = markSetupDone(memory);
    await writeMemory(projectId, memory);
    say("\n\nNo problem -- I'll keep building on these notes as we go.");
    return memory;
  }

  for (const task of chosen) {
    say(`\n\n**${task.label}**`);
    memory = await runTask(projectId, memory, task, description, ui, out, signal);
  }

  memory = markSetupDone(memory);
  await writeMemory(projectId, memory);
  say("\n\nThat's your project set up -- I'll keep building on these notes as we go.");
  return memory;
}

/**
 * The same dialogs, saying on the status row that the wait is the user's.
 *
 * Without this the row went on showing the last model call's clock behind an
 * open question -- "Writing, 2m 10s" over a form nobody had filled in yet,
 * which reads as a model that has hung.
 */
function asking(ui: MemoryUi, out: SetupOutput): MemoryUi {
  return {
    choose: (choice) => { out.progress({ phase: "asking" }); return ui.choose(choice); },
    input: (title, placeholder) => { out.progress({ phase: "asking" }); return ui.input(title, placeholder); },
    form: (title, message, fields) => { out.progress({ phase: "asking" }); return ui.form(title, message, fields); },
  };
}

async function review(ui: MemoryUi, title: string, items: readonly NewItem[]): Promise<NewItem[]> {
  const answer = await ui.form(title, "Edit or clear anything that isn't right.", itemsToFields(items, true));
  return answer ? fieldsToItems(items, answer) : [];
}

async function runTask(
  projectId: string,
  memory: ProjectMemory,
  task: Task,
  description: string,
  ui: MemoryUi,
  out: SetupOutput,
  signal?: AbortSignal,
): Promise<ProjectMemory> {
  const { say } = out;
  const questions = await (async () => {
    try {
      return parseTaskQuestions(await ask(buildTaskQuestionsPrompt(task, description, memory), signal, out));
    } catch {
      return [];
    }
  })();

  const answered: AnsweredQuestion[] = [];
  for (const q of questions) {
    const answer = q.options.length
      ? await ui.choose({ title: q.ask, options: q.options, ...(q.multi ? { multi: true } : {}) })
      : await ui.input(q.ask);
    answered.push({ ask: q.ask, answer: answer ?? "" });
  }

  const items = await (async () => {
    try {
      return parseTaskResult(await ask(buildTaskResultPrompt(task, description, answered, memory), signal, out));
    } catch {
      return [];
    }
  })();

  if (!items.length) {
    say(" Nothing new to note here.");
    return memory;
  }

  const approved = await review(ui, task.label, items);
  if (!approved.length) {
    say(" Nothing kept.");
    return memory;
  }

  const next = addItems(memory, approved, "setup");
  await writeMemory(projectId, next);
  say(` Saved ${approved.length} note${approved.length === 1 ? "" : "s"}.`);
  return next;
}

/* ------------------------------------------------------------------ *
 * Growing on its own                                                  *
 * ------------------------------------------------------------------ */

/**
 * The automatic pass, run by the chat turn itself before the model replies.
 *
 * It used to wait for ninety seconds of quiet, which made "let's go with X"
 * look ignored: the person who had just settled something checked the notes,
 * found nothing, and kept talking -- and every message restarted the wait.
 * Before the reply, the note exists by the time the answer does, and the reply
 * is written with it already in the project block.
 *
 * Only ever called for a turn `handleSend` has already cleared to write notes
 * -- a research project, automatic notes on, not the setup chat -- which is
 * also what keeps it from creating a memory file for a simple folder: the old
 * timer read a missing file as an empty memory with `auto` on and wrote it
 * back, turning the folder into a research project behind its owner's back.
 *
 * No resident-model check is needed any more: the turn has already resolved
 * the chat endpoint, so the model this asks is the one answering anyway. And
 * the cost to the reply is one short request, not a re-read of the whole
 * conversation -- the bundled llama-server (b10375) keeps a host-memory prompt
 * cache (`--cache-ram`, 8192 MiB by default), so the conversation's cached
 * prompt displaced by this request is restored for the reply, not recomputed.
 *
 * Reasoning follows the chat turn's own switch (`extra`), which is what makes
 * this fast for someone who turned thinking off -- without it, a template that
 * thinks by default would think here too.
 */
export async function notesBeforeReply(
  projectId: string,
  session: Session,
  signal: AbortSignal,
): Promise<NotePass | undefined> {
  const memory = await readMemory(projectId);
  if (!memory.auto) return undefined;
  const pass = await notePass(memory, session.messages_, session.id, (prompt) =>
    ask(prompt, signal, undefined, { reasoning: true }),
  );
  if (!pass) return undefined;
  await writeMemory(projectId, pass.memory);
  if (pass.added.length) host().send("myra:project-memory-changed", { projectId });
  return pass;
}

/** The line a turn shows when its pass saved something -- said where it happened. */
export function notedNotice(added: readonly { text: string }[]): string {
  return (
    `Added to this project's notes: ${added.map((it) => `“${it.text}”`).join("; ")} — ` +
    `edit or remove ${added.length === 1 ? "it" : "them"} from the project page.`
  );
}

/* ------------------------------------------------------------------ *
 * IPC: the memory editor, and the manual "update from this chat"      *
 * ------------------------------------------------------------------ */

function slotOf(raw: unknown): MemorySlot | undefined {
  const slots: MemorySlot[] = ["questions", "aims", "theory", "methods", "decisions", "open", "context"];
  return typeof raw === "string" && (slots as string[]).includes(raw) ? (raw as MemorySlot) : undefined;
}

export function installMemoryIpc(installed: MemoryDeps): void {
  setMemoryHost(installed);
  const { send } = installed;

  ipcMain.handle("myra:project-memory", async (_e, id: unknown) => ({
    ok: true,
    memory: await readMemory(String(id ?? "")),
  }));

  ipcMain.handle("myra:project-memory-start-setup", async (_e, id: unknown) => {
    const projectId = String(id ?? "");
    const memory = await readMemory(projectId);
    const next = { ...memory, setup: "pending" as const };
    await writeMemory(projectId, next);
    return { ok: true, memory: next };
  });

  ipcMain.handle("myra:project-memory-add", async (_e, id: unknown, slot: unknown, text: unknown) => {
    const projectId = String(id ?? "");
    const s = slotOf(slot);
    if (!s || typeof text !== "string" || !text.trim()) return { ok: false, error: "Nothing to add." };
    const memory = addItems(await readMemory(projectId), [{ slot: s, text }], "you");
    await writeMemory(projectId, memory);
    return { ok: true, memory };
  });

  ipcMain.handle("myra:project-memory-edit", async (_e, id: unknown, itemId: unknown, text: unknown) => {
    const projectId = String(id ?? "");
    const memory = editItem(await readMemory(projectId), String(itemId ?? ""), String(text ?? ""));
    await writeMemory(projectId, memory);
    return { ok: true, memory };
  });

  ipcMain.handle("myra:project-memory-remove", async (_e, id: unknown, itemId: unknown) => {
    const projectId = String(id ?? "");
    const memory = removeItem(await readMemory(projectId), String(itemId ?? ""));
    await writeMemory(projectId, memory);
    return { ok: true, memory };
  });

  ipcMain.handle("myra:project-memory-set-auto", async (_e, id: unknown, auto: unknown) => {
    const projectId = String(id ?? "");
    const memory = setAuto(await readMemory(projectId), auto === true);
    await writeMemory(projectId, memory);
    return { ok: true, memory };
  });

  /**
   * "Update project memory from this chat": the same grounding pass every
   * turn runs before its reply, but on demand and with a review dialog instead
   * of an unattended save -- the two share `groundProposals` and differ only
   * in who presses the button that turns a grounded item into a kept one.
   */
  ipcMain.handle("myra:project-memory-update", async (_e, id: unknown) => {
    const projectId = String(id ?? "");
    const session = installed.currentSession();
    let memory = await readMemory(projectId);
    const since = memory.seen[session.id] ?? 0;

    let grounded: NewItem[];
    try {
      const proposals = parseProposals(await ask(buildUpdatePrompt(memory, session.messages_, since)));
      /* Unreadable is not "nothing found": the stretch stays unread, so the
         next turn's own pass still looks at it. */
      if (!proposals) return { ok: true, added: 0, memory };
      grounded = groundProposals(proposals, session.messages_);
    } catch {
      return { ok: true, added: 0, memory };
    }
    // The watermark moves whether or not anything was found or kept -- a
    // pass that found nothing is a finished pass, the same rule the deep
    // research pipeline's own stages run on.
    memory = { ...memory, seen: { ...memory.seen, [session.id]: session.messages_.length } };

    if (!grounded.length) {
      await writeMemory(projectId, memory);
      send("myra:project-memory-changed", { projectId });
      return { ok: true, added: 0, memory };
    }

    const approved = await review(installed.ui, "Update this project's notes?", grounded);
    if (approved.length) memory = addItems(memory, approved, "you");
    await writeMemory(projectId, memory);
    send("myra:project-memory-changed", { projectId });
    return { ok: true, added: approved.length, memory };
  });
}
