/**
 * Growing a project's memory: the setup chat, the "update from this chat"
 * button, and the background pass that does the same thing on its own.
 *
 * The IPC wiring belongs here for the reason [projects.ts](./projects.ts)'s
 * does: nothing in [core/projects/](../core/projects/memory.ts) may import
 * `electron`, so the part that reads Settings, resolves a model and pops a
 * dialog lives in main. `runProjectSetup` and `runAutoUpdate` still import
 * only pure functions from core -- `runSubagent` and the dialog callbacks are
 * the only side effects either one performs.
 */

import { ipcMain } from "electron";

import type { ConfigStore, EndpointSettings } from "../core/config.ts";
import type { Session } from "../core/sessions.ts";
import { runSubagent } from "../core/llm/chat.ts";
import type { Choice } from "../core/research/questions.ts";
import {
  addItems, editItem, fieldsToItems, itemsToFields, markSetupDone, mergeAuto, removeItem, setAuto,
  type MemoryFormField, type MemorySlot, type NewItem, type ProjectMemory,
} from "../core/projects/memory.ts";
import {
  buildOffersPrompt, buildTaskQuestionsPrompt, buildTaskResultPrompt, FIXED_TASKS, parseOffers,
  parseTaskQuestions, parseTaskResult, SETUP_GREETING, type AnsweredQuestion, type Task,
} from "../core/projects/intake.ts";
import { buildUpdatePrompt, groundProposals, parseProposals } from "../core/projects/memoryUpdate.ts";
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
  llm: () => Promise<{ endpoint: EndpointSettings; apiKey?: string }>;
  /** The conversation "update from this chat" reads -- always whichever one is open. */
  currentSession: () => Session;
  ui: MemoryUi;
  /** A chat turn or a long job (paper, review) is already using the model. */
  busy: () => boolean;
  /** Whether calling `llm()` right now would need to load a LOCAL model that
   *  is not already resident. True for a hosted choice unconditionally --
   *  there is no card to spare there. */
  modelReady: () => boolean;
}

let deps: MemoryDeps | undefined;

export function setMemoryHost(installed: MemoryDeps | undefined): void {
  deps = installed;
}

function host(): MemoryDeps {
  if (!deps) throw new Error("Project memory is not available: the app has not attached its host.");
  return deps;
}

async function ask(prompt: string, signal?: AbortSignal): Promise<string> {
  const { llm } = host();
  const resolved = await llm();
  const { text } = await runSubagent({
    model: resolved.endpoint.model ?? "",
    prompt,
    endpoint: resolved.endpoint,
    ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
    ...(signal ? { signal } : {}),
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
 * `say` receives DELTAS, the same shape an ordinary reply's text events are --
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
  say: (delta: string) => void,
  signal?: AbortSignal,
): Promise<ProjectMemory> {
  let memory = await readMemory(projectId);
  const { ui } = host();

  say("Thanks. Let me see what's worth noting here.");

  const draft = await (async () => {
    try {
      return parseOffers(await ask(buildOffersPrompt(description), signal));
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
    memory = await runTask(projectId, memory, task, description, ui, say, signal);
  }

  memory = markSetupDone(memory);
  await writeMemory(projectId, memory);
  say("\n\nThat's your project set up -- I'll keep building on these notes as we go.");
  return memory;
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
  say: (delta: string) => void,
  signal?: AbortSignal,
): Promise<ProjectMemory> {
  const questions = await (async () => {
    try {
      return parseTaskQuestions(await ask(buildTaskQuestionsPrompt(task, description, memory), signal));
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
      return parseTaskResult(await ask(buildTaskResultPrompt(task, description, answered, memory), signal));
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
 * A quiet stretch, not a fixed clock -- restarted on every turn, so the pass
 * only ever runs after the conversation has actually gone idle.
 */
const AUTO_DELAY_MS = 90_000;

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Called at the end of every turn in a project. Debounced per conversation. */
export function scheduleAutoUpdate(projectId: string, session: Session): void {
  const existing = timers.get(session.id);
  if (existing) clearTimeout(existing);
  timers.set(
    session.id,
    setTimeout(() => {
      timers.delete(session.id);
      void runAutoUpdate(projectId, session);
    }, AUTO_DELAY_MS),
  );
}

async function runAutoUpdate(projectId: string, session: Session): Promise<void> {
  const d = host();
  /* Something else is using the model right now -- try again after the same
     quiet delay rather than dropping the pass; a long research run must not
     silently cost this conversation its next update. */
  if (d.busy()) {
    scheduleAutoUpdate(projectId, session);
    return;
  }
  /* Never for the sake of this. A local model MyRA is not already holding
     for the user must not be loaded just to write a note -- see the module
     header. The next real turn re-arms this timer regardless. */
  if (!d.modelReady()) return;

  const memory = await readMemory(projectId);
  if (!memory.auto) return;
  const since = memory.seen[session.id] ?? 0;
  if (since >= session.messages_.length) return;

  let grounded: NewItem[];
  try {
    const text = await ask(buildUpdatePrompt(memory, session.messages_, since));
    grounded = groundProposals(parseProposals(text), session.messages_);
  } catch {
    // Left un-advanced on purpose: a transient failure is retried on the next
    // quiet stretch rather than quietly marked as though nothing was missed.
    return;
  }

  const merged = mergeAuto(memory, grounded, session.id, session.messages_.length);
  await writeMemory(projectId, merged);
  if (merged.items.length !== memory.items.length) {
    d.send("myra:project-memory-changed", { projectId });
  }
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
   * "Update project memory from this chat": the same grounding pass the
   * background timer runs, but on demand and with a review dialog instead of
   * an unattended save -- the two share `groundProposals` and differ only in
   * who presses the button that turns a grounded item into a kept one.
   */
  ipcMain.handle("myra:project-memory-update", async (_e, id: unknown) => {
    const projectId = String(id ?? "");
    const session = installed.currentSession();
    let memory = await readMemory(projectId);
    const since = memory.seen[session.id] ?? 0;

    let grounded: NewItem[] = [];
    try {
      const text = await ask(buildUpdatePrompt(memory, session.messages_, since));
      grounded = groundProposals(parseProposals(text), session.messages_);
    } catch {
      grounded = [];
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
