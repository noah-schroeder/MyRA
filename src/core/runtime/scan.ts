/**
 * Finding GGUF models the user already has.
 *
 * Someone moving off LM Studio has tens of gigabytes on disk already, and
 * asking them to download it all again is the fastest way to make them keep
 * both apps. So we look in the places other tools keep plain GGUF files and
 * offer to run them where they are.
 *
 * Three rules, and they are what keeps this from being rude:
 *
 *   1. **Read only.** Nothing here moves, renames, links or deletes a file in
 *      another application's directory.
 *   2. **Resolve every time.** A path found today may be gone tomorrow, because
 *      the owning app is entitled to clean up after itself. Paths are re-checked
 *      at launch rather than cached and trusted.
 *   3. **Say where it came from.** A model listed as "found in LM Studio" is
 *      one the user can reason about when it disappears.
 *
 * Ollama is deliberately absent. It stores content-addressed blobs plus JSON
 * manifests rather than named files, so using it would mean parsing another
 * app's private index -- and this app is meant to replace it, not depend on it.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export interface ModelStore {
  /** Shown to the user. */
  label: string;
  dir: string;
  /** How deep to walk. HF's cache buries files under snapshots/<rev>/. */
  depth: number;
}

export function knownStores(home = homedir()): ModelStore[] {
  return [
    { label: "LM Studio", dir: join(home, ".lmstudio", "models"), depth: 4 },
    // Where LM Studio kept models before the directory moved.
    { label: "LM Studio", dir: join(home, ".cache", "lm-studio", "models"), depth: 4 },
    { label: "llama.cpp", dir: join(home, ".cache", "llama.cpp"), depth: 2 },
    { label: "HuggingFace", dir: join(home, ".cache", "huggingface", "hub"), depth: 5 },
  ];
}

export interface FoundModel {
  path: string;
  size: number;
  /** Which application's directory it was found in. */
  source: string;
  /** The filename, which is all most of these stores record. */
  name: string;
}

/** A directory walk, injected so this is testable without a filesystem. */
export interface WalkFs {
  readdir(dir: string): Promise<{ name: string; isDirectory: boolean; isFile: boolean }[]>;
  size(path: string): Promise<number>;
}

/**
 * Walk one store, bounded by depth and by a file cap.
 *
 * The cap matters: a HuggingFace cache can hold thousands of entries, and this
 * runs while someone is waiting for a settings page to open.
 */
export async function scanStore(store: ModelStore, fs: WalkFs, limit = 200): Promise<FoundModel[]> {
  const found: FoundModel[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth < 0 || found.length >= limit) return;
    let entries: { name: string; isDirectory: boolean; isFile: boolean }[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return; // Absent or unreadable: this store simply is not here.
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      const path = join(dir, entry.name);
      if (entry.isFile && entry.name.toLowerCase().endsWith(".gguf")) {
        try {
          found.push({ path, size: await fs.size(path), source: store.label, name: entry.name });
        } catch {
          // Vanished between listing and stat: skip rather than fail the scan.
        }
      } else if (entry.isDirectory && !entry.name.startsWith(".")) {
        await walk(path, depth - 1);
      }
    }
  };

  await walk(store.dir, store.depth);
  return found;
}

/**
 * Collapse shards and duplicates across stores.
 *
 * The same file often exists twice -- once in the HuggingFace cache and once
 * where LM Studio hard-linked it -- and a list showing both invites the user to
 * wonder which is real.
 */
export function dedupeFound(models: FoundModel[]): FoundModel[] {
  const seen = new Map<string, FoundModel>();
  for (const m of models) {
    const key = `${m.name}:${m.size}`;
    if (!seen.has(key)) seen.set(key, m);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Local servers worth offering to use directly rather than borrowing files from. */
export const LOCAL_SERVERS = [
  { label: "Ollama", url: "http://127.0.0.1:11434/v1" },
  { label: "LM Studio", url: "http://127.0.0.1:1234/v1" },
  { label: "llama.cpp", url: "http://127.0.0.1:8080/v1" },
] as const;
