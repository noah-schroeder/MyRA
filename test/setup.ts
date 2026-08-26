/**
 * Runs before any test module is loaded.
 *
 * `CONFIG_DIR` in core/paths.ts is resolved once, at import time, from
 * KAREN_CONFIG_DIR. Setting that variable inside a test is therefore too late:
 * by then the constant is already bound to the developer's real
 * ~/.config/karen, and any test touching settings or the research config reads
 * whatever they last clicked in the running app.
 *
 * That is not hypothetical. A gate test asserting "the scholarly tool stays
 * reachable" began failing during unrelated UI work, because clicking Quick in
 * the app wrote mode: "web" to the real config file and the tool is disabled in
 * that mode by design. The test was reading live application state.
 *
 * Node loads `--import` modules before the test files, which is early enough.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "karen-test-"));

/*
 * All three, because they are resolved independently.
 *
 * KAREN_CONFIG_DIR alone is not enough: researchConfigPath() reads its own
 * variable and otherwise falls back to the real ~/.config/karen, and
 * researchRoot() defaults to ~/Documents/karen/research -- so a test run could
 * both read the developer's settings and write run directories into their
 * documents folder.
 */
process.env["KAREN_CONFIG_DIR"] = dir;
process.env["KAREN_RESEARCH_CONFIG"] = join(dir, "research.json");
process.env["KAREN_RESEARCH_ROOT"] = join(dir, "research");
