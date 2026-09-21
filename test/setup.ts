/**
 * Runs before any test module is loaded.
 *
 * `CONFIG_DIR` in core/paths.ts is resolved once, at import time, from
 * MYRA_CONFIG_DIR. Setting that variable inside a test is therefore too late:
 * by then the constant is already bound to the developer's real
 * ~/.config/myra, and any test touching settings or the research config reads
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

const dir = mkdtempSync(join(tmpdir(), "myra-test-"));

/*
 * All three, because they are resolved independently.
 *
 * MYRA_CONFIG_DIR alone is not enough: researchConfigPath() reads its own
 * variable and otherwise falls back to the real ~/.config/myra, and
 * researchRoot() defaults to ~/Documents/myra/research -- so a test run could
 * both read the developer's settings and write run directories into their
 * documents folder.
 *
 * MYRA_WORKSPACE for the same reason, one folder up: workspaceRoot() falls
 * back to ~/Documents/myra, so anything reaching writeText -- the document
 * tools, the paper exporter, a draft -- wrote a real file into the
 * developer's own documents folder. Observed while testing the jail: a smoke
 * check meant for a temporary directory left a file in ~/Documents/myra.
 */
process.env["MYRA_CONFIG_DIR"] = dir;
process.env["MYRA_RESEARCH_CONFIG"] = join(dir, "research.json");
process.env["MYRA_RESEARCH_ROOT"] = join(dir, "research");
process.env["MYRA_WORKSPACE"] = join(dir, "workspace");
