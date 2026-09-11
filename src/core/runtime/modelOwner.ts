/**
 * Who a model on this machine actually belongs to, and what deleting it means.
 *
 * Three different acts wear the same button. MyRA's own downloads sit in the
 * daemon's cache and it will remove them on request. MyRA's models folder is
 * MyRA's, and the daemon refuses to touch it -- measured, `lemond` 11.8.0
 * answers a delete for anything under `extra_models_dir` with
 *
 *     500 Cannot delete extra models via API. Models in --extra-models-dir are
 *     user-managed. Delete the file directly from: …
 *
 * naming the path. And the third is a file inside LM Studio's or Ollama's own
 * library, which MyRA reads where it lies and never copies.
 *
 * That last one is the reason this is a module and not an `if` in a component.
 * A row that says "this belongs to LM Studio" beside a main process that
 * deletes it without a second thought is exactly the drift the app's other
 * shared rules exist to prevent, so the words on the button, the confirmation
 * it demands, and what the main process then does all read from here.
 *
 * The user's decision, recorded because it is not the obvious one: LM Studio
 * and Ollama models stay on the list and stay deletable. Hiding them would be
 * a lie about what is on the disk, and refusing to delete them would leave the
 * one case where somebody actually needs the space with no button at all. What
 * is owed instead is a warning that says what will happen in the other
 * application, and a second, differently-worded press.
 */

import { SOURCE_LABELS, type ForeignSource } from "./foreign.ts";

export type Owner = "myra" | "myra-folder" | "lmstudio" | "ollama";

/**
 * Decide from what the daemon reports plus what the index recorded.
 *
 * The foreign map wins: a model reached through the index is somebody else's
 * file whatever Lemonade calls its source, and Lemonade calls every one of
 * them `extra_models_dir` because that is the only door it has.
 */
export function ownerOf(opts: {
  /** Lemonade's own `source` field: `huggingface`, `extra_models_dir`, … */
  source?: string | undefined;
  /** Set when the model index put this id there on another app's behalf. */
  foreign?: ForeignSource | undefined;
}): Owner {
  if (opts.foreign) return opts.foreign;
  return opts.source === "extra_models_dir" ? "myra-folder" : "myra";
}

/** Which application's library a model lives in, or MyRA's own. */
export function ownerLabel(owner: Owner): string {
  return owner === "lmstudio" || owner === "ollama" ? SOURCE_LABELS[owner] : "MyRA";
}

export interface DeletePrompt {
  title: string;
  body: string;
  /** The word on the button that actually removes it. */
  confirm: string;
  /**
   * Whether the first press may only warn.
   *
   * True exactly where the file is another application's, because a
   * destructive action that reaches outside this app should take two
   * deliberate steps rather than one.
   */
  warns: boolean;
  /** Whether to offer Reveal beside the confirmation. */
  reveal: boolean;
  /**
   * Whether the backend has to restart for the row to go away.
   *
   * Lemonade reads `extra_models_dir` once at startup, so anything reached
   * through the index outlives its own file until the daemon is restarted.
   * Said out loud because it unloads whatever model is currently loaded.
   */
  restarts: boolean;
}

export function deletePrompt(opts: {
  owner: Owner;
  /** As shown on the row. */
  name: string;
  /** Already formatted -- "1.5 GB". The app has size formatters; core has none. */
  size?: string | undefined;
  /** The real file, resolved. Shown before anything is removed. */
  path?: string | undefined;
}): DeletePrompt {
  const { owner, name, size, path } = opts;
  const freed = size ? ` That frees ${size}.` : "";

  if (owner === "lmstudio" || owner === "ollama") {
    const app = SOURCE_LABELS[owner];
    /* Ollama is the sharper edge of the two, and the warning says so rather
       than treating both the same. It stores models as content-addressed
       blocks that several models can share, so a file this row names may be
       part of another model as well -- a fact nobody could infer from a
       filename that is a hash. */
    const risk = owner === "ollama"
      ? `${app} stores models as shared blocks, so this file may be part of another model there too.`
      : `${app} keeps its own record of it, so removing it from here may leave a broken entry or an error there.`;
    return {
      title: `${name} belongs to ${app}.`,
      body:
        `MyRA reads this file where it lies and has never copied it.${freed ? ` Deleting it frees ${size}.` : ""}` +
        ` ${risk} Deleting it in ${app} instead is the tidier way.` +
        (path ? ` The file is ${path}.` : "") +
        " MyRA will restart its backend afterwards, which unloads whatever is loaded.",
      confirm: `Delete ${app}’s file`,
      warns: true,
      reveal: true,
      restarts: true,
    };
  }

  if (owner === "myra-folder") {
    return {
      title: `Delete ${name}?`,
      body:
        `This one is in MyRA’s own models folder, and deleting it removes the file from disk.${freed}` +
        " MyRA will restart its backend afterwards, which unloads whatever is loaded." +
        " You can download it again later.",
      confirm: "Delete",
      warns: false,
      reveal: true,
      restarts: true,
    };
  }

  return {
    title: `Delete ${name}?`,
    body: `MyRA downloaded this one, and deleting it removes it from this machine.${freed} You can download it again later.`,
    confirm: "Delete",
    warns: false,
    reveal: false,
    restarts: false,
  };
}
