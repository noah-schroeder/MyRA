/**
 * Questions the main process has asked the window, and is waiting on.
 *
 * Lifted out of main/index.ts so it can be tested, the same split
 * projectStore.ts and modelDelete.ts already got: a module that imports
 * `electron` cannot be loaded by the test runner at all, and this decides
 * whether a permission prompt can be answered by something that never showed
 * it.
 *
 * Two things were wrong with the version this replaces, and both are about
 * the ids rather than the asking:
 *
 *   - They were sequential (`p1`, `p2`, ...). Any code that reached the
 *     `myra:answer-prompt` channel could answer a question it had never been
 *     shown, by guessing the next number -- including the tool-approval
 *     confirm, which is the second line of defence behind the registry.
 *   - Nothing cleared them. A question outstanding when the window reloaded
 *     left `approve()` awaiting a promise nothing would ever resolve, which
 *     hung the whole turn with no way back except restarting the app.
 */

import { randomUUID } from "node:crypto";

export type Answer = string | undefined;

export class PendingPrompts {
  readonly #open = new Map<string, (answer: Answer) => void>();

  get size(): number {
    return this.#open.size;
  }

  /**
   * Register a question and get the id to send with it.
   *
   * `randomUUID` rather than a counter: unguessable is the property that
   * matters, and there is no second use for the number.
   */
  open(): { id: string; answer: Promise<Answer> } {
    const id = randomUUID();
    const answer = new Promise<Answer>((resolve) => this.#open.set(id, resolve));
    return { id, answer };
  }

  /**
   * Settle one question. Unknown or already-answered ids do nothing.
   *
   * Deleted before resolving, so a window that sends the same answer twice --
   * a double click, a re-render -- cannot resolve a later question that
   * happens to reuse the id.
   */
  answer(id: string, value: Answer): boolean {
    const resolve = this.#open.get(id);
    if (!resolve) return false;
    this.#open.delete(id);
    resolve(value);
    return true;
  }

  /**
   * Settle everything outstanding as unanswered.
   *
   * For a window that navigated or reloaded: whoever was going to answer is
   * gone. `undefined` is already the right answer everywhere -- `approve`
   * returns `answer === "yes"`, so it denies, and the research pipeline
   * treats no answer as a real one by design.
   */
  cancelAll(): number {
    const waiting = [...this.#open.values()];
    this.#open.clear();
    for (const resolve of waiting) resolve(undefined);
    return waiting.length;
  }
}
