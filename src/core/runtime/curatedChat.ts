/**
 * MyRA's own picks for "Chat and writing", as real Hugging Face repositories.
 *
 * Not Lemonade's bundled catalogue: on the catalogue installed at the time
 * this was written, 165 of 178 "chat and writing" entries carried upstream's
 * `suggested` flag, including base (non-instruct) models -- a flag that fires
 * on 93% of a group has stopped distinguishing anything, and it cannot name a
 * repository upstream never bundled in the first place. These are resolved
 * live against the registry each time the Recommended tab's chat group is
 * opened, the same way any other repository on this page is.
 *
 * Hand-picked, not derived. Edit freely -- one repository id per line.
 */
export const CURATED_CHAT: readonly string[] = [
  "unsloth/gemma-4-E4B-it-GGUF",
  "unsloth/gemma-4-26B-A4B-it-GGUF",
  "bartowski/Qwen3.8-27B-GGUF",
  "unsloth/gemma-4-31B-it-GGUF",
  "unsloth/Qwen3.6-35B-A3B-MTP-GGUF",
  "unsloth/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF",
  "LiquidAI/LFM2.5-2.6B-GGUF",
];
