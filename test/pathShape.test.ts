/**
 * The SHAPE of path handling, not the behaviour of any one call.
 *
 * Every finding this file guards against was written the same way: code that
 * is correct on the platform it was written on, or on the day it was written,
 * and silently wrong later. `safeRelativePath` split on "/" alone, which is
 * right on Linux and a jail escape on Windows -- a platform this repo ships an
 * installer for. Two `shell.showItemInFolder(String(path))` calls sat three
 * files from the one handler that resolves through the jail first. Eight
 * spawns inherited every exported API key.
 *
 * The behaviour is pinned elsewhere -- docs.test.ts, jail.test.ts,
 * reveal.test.ts, childEnv.test.ts. What is pinned HERE is that the mistake
 * cannot be made again without a test naming it, which is the only version of
 * this that survives the next contributor.
 *
 * Modelled on modeGates.test.ts, including its trick of blanking block
 * comments rather than deleting them, so a reported line number is right.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (path.endsWith(".ts") || path.endsWith(".tsx")) out.push(path);
  }
  return out;
}

/** Comments explain these bugs; they are not the bugs. */
function code(file: string): string[] {
  const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) =>
    c.replace(/[^\n]/g, " "),
  );
  return text.split("\n").map((line) => line.replace(/\/\/.*$/, ""));
}

function scan(roots: string[], match: (line: string) => boolean, skip: string[] = []): string[] {
  const offenders: string[] = [];
  for (const root of roots) {
    for (const file of sources(root)) {
      if (skip.some((s) => file.endsWith(s))) continue;
      code(file).forEach((line, i) => {
        if (match(line)) offenders.push(`${file}:${i + 1} ${line.trim()}`);
      });
    }
  }
  return offenders;
}

/**
 * A path handed to the shell or to a delete must be one MyRA resolved.
 *
 * `myra:project-reveal` and `myra:paper-reveal` both did
 * `shell.showItemInFolder(String(path))` on a raw string off IPC, while
 * `myra:document-reveal` in the same process resolved through the jail first.
 * The fix is `revealInside`; this is what stops the fourth one.
 */
test("no path goes straight from the window to a destructive or revealing call", () => {
  /* `deleteRun` is deliberately absent: it resolves through `runDir`, which
     calls assertRunId and then checks containment again before the rm. What is
     listed here is the raw verbs and the one wrapper -- deleteMeeting -- that
     is a bare `rm -rf` over whatever it is given. */
  const verbs = /\b(rm|rmdir|unlink|cp|copyFile|showItemInFolder|openPath|deleteMeeting)\s*\(\s*String\(/;
  const offenders = scan(["src/core", "src/main", "src/preload"], (l) => verbs.test(l));
  assert.deepEqual(
    offenders,
    [],
    "Resolve it first -- see revealInside() in src/main/reveal.ts and the " +
      "assert*Id guards -- rather than coercing whatever arrived:\n" + offenders.join("\n"),
  );
});

/**
 * POSIX-only path arithmetic, in the modules that validate paths.
 *
 * Scoped to those modules on purpose: `split("/")` on a URL or a model id is
 * fine, and a rule that flagged those would be turned off within a month.
 * What is not fine is deciding whether a name escapes a directory by looking
 * for "/" when the app ships to Windows and macOS.
 */
test("nothing decides containment by looking for a forward slash", () => {
  const roots = [
    "src/core/documents",
    "src/core/agent/tools",
    "src/core/projects",
    "src/core/meetings",
  ];
  const files = ["src/main/projects.ts", "src/main/papers.ts", "src/main/meetings.ts", "src/main/reveal.ts"];

  /*
   * The one file allowed to spell a separator out, because it is the file
   * that decides what one means: safeRelativePath, looksAbsolute and baseName
   * all live there and are checked against path.win32 and path.posix in
   * docs.test.ts. This is ladder.ts's exemption in modeGates.test.ts, for the
   * same reason -- the definition has to be somewhere.
   */
  const OWNER = join("src", "core", "documents", "formats.ts");

  const shapes = [
    /(?:split|lastIndexOf|indexOf|startsWith|endsWith)\(\s*"\//,
    /\+\s*"\/"/,
  ];
  const offenders = scan(roots, (l) => shapes.some((re) => re.test(l)), [OWNER]);
  for (const file of files) {
    code(file).forEach((line, i) => {
      if (shapes.some((re) => re.test(line))) offenders.push(`${file}:${i + 1} ${line.trim()}`);
    });
  }

  assert.deepEqual(
    offenders,
    [],
    "MyRA ships to Windows and macOS. Use safeRelativePath, looksAbsolute, " +
      "baseName or insideRoot, which are checked against all three:\n" + offenders.join("\n"),
  );
});

/** The text between a call's parentheses, balanced. */
function callBody(text: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return text.slice(openParen + 1, i);
    }
  }
  return text.slice(openParen + 1);
}

/**
 * A child inherits every exported API key unless its environment is scrubbed.
 *
 * pandoc does not need ANTHROPIC_API_KEY and llama-server does not need
 * HF_TOKEN. There are a handful of spawn sites, so an allowlist of the ones
 * that pass `env:` is cheap, and it catches the next one.
 */
test("every spawned process is given an environment rather than inheriting ours", () => {
  const files = [...sources("src/core"), ...sources("src/main")];
  const offenders: string[] = [];
  for (const file of files) {
    const text = code(file).join("\n");
    for (const match of text.matchAll(/\bspawn\s*\(/g)) {
      /* The options object is often many lines below the call, past a long
         comment, so the argument list is read by balancing parentheses
         rather than by taking a fixed window. */
      const body = callBody(text, match.index + match[0].length - 1);
      if (/\benv:/.test(body)) continue;
      // taskkill, which takes a pid and a signal and reads nothing.
      if (/taskkill/.test(body)) continue;
      offenders.push(`${file}: ${body.replace(/\s+/g, " ").slice(0, 90)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "Pass env: scrubbedEnv(process.env) -- see src/core/childEnv.ts:\n" + offenders.join("\n"),
  );
});
