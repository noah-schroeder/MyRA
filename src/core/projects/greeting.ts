/**
 * The one line of `intake.ts` the renderer needs on its own.
 *
 * Split out so it costs nothing to import: `intake.ts` pulls in
 * `parseJsonReply` from `core/llm/chat.ts`, which reaches `core/config.ts`
 * and, through it, `node:fs/promises` -- fine for main, fatal for a
 * sandboxed renderer bundle. The renderer shows this greeting the moment an
 * empty conversation opens in a project whose setup has not run, before any
 * message -- and therefore before main has said anything at all -- so it
 * cannot come from a round trip; it has to be a constant both sides can read.
 */
export const SETUP_GREETING = [
  "This is a research project. Tell me about it -- what you're studying, why it matters, and",
  "anything you already know about how you want to approach it. Once you have, I'll suggest some",
  "ways I can help, and whatever comes out of that gets kept as this project's notes so you don't",
  "have to say it again next time.",
].join(" ");
