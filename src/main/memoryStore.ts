/**
 * A project's memory, on disk.
 *
 * Split from [projectMemory.ts](./projectMemory.ts) for the reason
 * [projectStore.ts](./projectStore.ts) is split from [projects.ts](./projects.ts):
 * a module that imports `electron` cannot be loaded by the test runner at all.
 *
 * A separate file from the project record itself, in a subdirectory of
 * `projects/` rather than beside it: [projectStore.ts](./projectStore.ts)'s
 * `readAll` treats every `*.json` directly inside `projects/` as a project,
 * and a memory written there would be read back as one and fail to parse as a
 * `Project` -- worse, `writeProject` racing a memory save at the end of a
 * chat turn (`fileInActiveProject` runs in the same `finally` block) could
 * drop whichever wrote second if the two shared a file. They never do.
 */

import { access, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { makeOwnDir, OWNER_ONLY_FILE } from "../core/paths.ts";
import { assertProjectId } from "../core/projects/project.ts";
import { newMemory, parseMemory, type ProjectMemory } from "../core/projects/memory.ts";
import { projectsDir } from "./projectStore.ts";

function memoryDir(): string {
  return join(projectsDir(), "memory");
}

function pathFor(id: string): string {
  return join(memoryDir(), `${assertProjectId(id)}.json`);
}

/** Told whenever a memory changes, the same shape `setProjectsWatcher` is. */
let watcher: (() => void) | undefined;

export function setMemoryWatcher(fn: (() => void) | undefined): void {
  watcher = fn;
}

export async function writeMemory(id: string, memory: ProjectMemory): Promise<ProjectMemory> {
  await makeOwnDir(memoryDir());
  const target = pathFor(id);
  const temp = `${target}.partial`;
  await writeFile(temp, `${JSON.stringify(memory, null, 2)}\n`, { mode: OWNER_ONLY_FILE });
  await rename(temp, target);
  watcher?.();
  return memory;
}

/** A project with no memory file at all reads as a plain, already-settled one. */
export async function readMemory(id: string): Promise<ProjectMemory> {
  try {
    return parseMemory(JSON.parse(await readFile(pathFor(id), "utf8")));
  } catch {
    return newMemory();
  }
}

/**
 * Whether this project keeps notes at all.
 *
 * `readMemory` cannot say: it reads a missing file as an empty, settled
 * memory, which is right for drawing a project page and wrong for deciding
 * whether the model may write one -- having a memory file is what makes a
 * project a research project, and a simple folder must not become one because
 * a model called `remember` inside it.
 */
export async function hasMemory(id: string): Promise<boolean> {
  try {
    await access(pathFor(id));
    return true;
  } catch {
    return false;
  }
}

export async function deleteMemory(id: string): Promise<void> {
  await rm(pathFor(id), { force: true });
}
