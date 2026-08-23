import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The extension is exercised against a REAL unix socket speaking the bridge's
 * framing, not a mocked client. The framing is the part that breaks: it is
 * LF-only by project rule, and a splitter that also broke on \r would desync
 * here exactly as it would in production.
 */
function fakeBridge(
  handler: (verb: string, args: any) => Promise<unknown> | unknown,
): Promise<{ path: string; close: () => Promise<void>; seen: { verb: string; args: any }[] }> {
  const dir = mkdtempSync(join(tmpdir(), "karen-sock-"));
  const path = join(dir, "karen-bridge.sock");
  const seen: { verb: string; args: any }[] = [];
  const server: Server = createServer((socket) => {
    let buf = "";
    socket.on("data", async (chunk) => {
      buf += chunk.toString("utf8");
      let at: number;
      while ((at = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, at);
        buf = buf.slice(at + 1);
        const req = JSON.parse(line);
        seen.push({ verb: req.verb, args: req.args });
        try {
          const result = await handler(req.verb, req.args);
          socket.write(JSON.stringify({ id: req.id, ok: true, result }) + "\n");
        } catch (err) {
          socket.write(JSON.stringify({ id: req.id, ok: false, error: (err as Error).message }) + "\n");
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(path, () =>
      resolve({
        path,
        seen,
        close: () => new Promise<void>((r) => server.close(() => r())),
      }),
    );
  });
}

async function withBridge<T>(
  handler: (verb: string, args: any) => Promise<unknown> | unknown,
  body: (tools: Map<string, any>, seen: { verb: string; args: any }[]) => Promise<T>,
): Promise<T> {
  const bridge = await fakeBridge(handler);
  const prev = process.env["XDG_RUNTIME_DIR"];
  process.env["XDG_RUNTIME_DIR"] = bridge.path.replace(/\/karen-bridge\.sock$/, "");
  try {
    const { stubApi } = await import("./harness.ts");
    const register = (await import("../host/index.ts")).default;
    const s = stubApi([]);
    register(s.pi);
    return await body(s.tools as Map<string, any>, bridge.seen);
  } finally {
    if (prev === undefined) delete process.env["XDG_RUNTIME_DIR"];
    else process.env["XDG_RUNTIME_DIR"] = prev;
    await bridge.close();
  }
}

test("every broker verb that works has a tool, and nothing else does", async () => {
  await withBridge(() => ({}), async (tools) => {
    assert.deepEqual([...tools.keys()].sort(), [
      "calendar_list", "clipboard_read", "clipboard_write", "contacts_search",
      "notify", "propose_event", "propose_task", "tasks_list",
      "vault_read", "vault_write",
    ]);
  });
});

test("proposing an event says proposed, never scheduled", async () => {
  await withBridge(
    () => ({ proposed: true }),
    async (tools, seen) => {
      const out = await tools.get("propose_event").execute("1", {
        title: "Review with Dana", start: "2026-08-25T14:00:00Z",
      });
      assert.equal(seen[0]!.verb, "calendar.propose_event");
      const text = out.content[0].text;
      assert.match(text, /Proposed \(not yet in the calendar\)/);
      assert.match(text, /waiting in the review queue/);
      // The failure that matters is claiming the event EXISTS.
      const claim = text.replace(/not yet in the calendar/gi, "");
      assert.doesNotMatch(claim, /\b(scheduled|created|added|booked)\b/i, claim);
    },
  );
});

test("an empty calendar range reads as empty, not as a failure", async () => {
  await withBridge(
    () => ({ events: [] }),
    async (tools) => {
      const out = await tools.get("calendar_list").execute("1", {});
      assert.match(out.content[0].text, /No events in that range/);
      assert.deepEqual(out.details.events, []);
    },
  );
});

test("calendar and contact arguments reach the broker unchanged", async () => {
  await withBridge(
    (verb) => (verb === "contacts.search" ? { contacts: [{ name: "Dana" }] } : { events: [] }),
    async (tools, seen) => {
      await tools.get("calendar_list").execute("1", { from: "2026-08-24", to: "2026-08-27", limit: 5 });
      assert.deepEqual(seen[0], { verb: "calendar.list", args: { from: "2026-08-24", to: "2026-08-27", limit: 5 } });
      const out = await tools.get("contacts_search").execute("2", { query: "dana" });
      assert.deepEqual(seen[1], { verb: "contacts.search", args: { query: "dana" } });
      assert.match(out.content[0].text, /Dana/);
    },
  );
});

test("a tool call reaches the broker as its verb, with its arguments", async () => {
  await withBridge(
    (verb) => (verb === "vault.read" ? { path: "/v/Karen/n.md", content: "# hi" } : {}),
    async (tools, seen) => {
      const out = await tools.get("vault_read").execute("1", { path: "Karen/n.md" });
      assert.equal(out.content[0].text, "# hi");
      assert.deepEqual(seen[0], { verb: "vault.read", args: { path: "Karen/n.md" } });
    },
  );
});

test("proposing a task says proposed, never created", async () => {
  await withBridge(
    () => ({ proposed: true }),
    async (tools, seen) => {
      const out = await tools.get("propose_task").execute("1", { content: "Buy milk" });
      assert.equal(seen[0]!.verb, "planify.propose");
      const text = out.content[0].text;
      assert.match(text, /Proposed \(not yet created\)/);
      assert.match(text, /waiting in the review queue/);
      // The failure mode that matters is the tool claiming the task EXISTS.
      // "not yet created" is the correct wording, so strip it before checking.
      const claim = text.replace(/not yet created/gi, "");
      assert.doesNotMatch(claim, /\b(added|created|scheduled)\b/i, claim);
    },
  );
});

test("a broker refusal is reported, not retried or swallowed", async () => {
  await withBridge(
    () => {
      throw new Error("path escapes the vault jail (writes are confined to /v/Karen)");
    },
    async (tools) => {
      const out = await tools.get("vault_write").execute("1", { path: "../../etc/x", content: "x" });
      assert.match(out.content[0].text, /escapes the vault jail/);
    },
  );
});

test("an unreachable bridge says nothing happened, rather than failing opaquely", async () => {
  const prev = process.env["XDG_RUNTIME_DIR"];
  process.env["XDG_RUNTIME_DIR"] = mkdtempSync(join(tmpdir(), "karen-nosock-"));
  try {
    const { stubApi } = await import("./harness.ts");
    const register = (await import("../host/index.ts")).default;
    const s = stubApi([]);
    register(s.pi);
    const out = await (s.tools as Map<string, any>).get("notify").execute("1", { title: "x" });
    assert.match(out.content[0].text, /host is unreachable/i);
    assert.match(out.content[0].text, /nothing on their machine changed/i);
  } finally {
    if (prev === undefined) delete process.env["XDG_RUNTIME_DIR"];
    else process.env["XDG_RUNTIME_DIR"] = prev;
  }
});

test("a slow approval is waited out rather than timing out under the dialog", async () => {
  await withBridge(
    async () => {
      // Stands in for a user who takes their time clicking Approve.
      await new Promise((r) => setTimeout(r, 300));
      return { text: "clipboard contents" };
    },
    async (tools) => {
      const out = await tools.get("clipboard_read").execute("1", {});
      assert.equal(out.content[0].text, "clipboard contents");
    },
  );
});

test("the research extension's tool gating does not drop the host tools", async () => {
  // applyMode() rewrites pi's whole active-tool list on session_start to force
  // the GUI's research mode. It filters by an allowlist of research tool names,
  // so anything it does not recognise must survive -- if it ever switched to
  // rebuilding the list from scratch, every host tool would vanish silently and
  // the agent would simply stop being able to reach the machine.
  const { stubApi } = await import("./harness.ts");
  const research = (await import("../research/index.ts")).default;
  const host = (await import("../host/index.ts")).default;

  const ALL = [
    "read", "bash", "edit", "write",
    "web_search", "fetch_page", "deep_research", "academic_research", "check_citations",
    "notify", "vault_read", "vault_write", "tasks_list", "propose_task",
    "clipboard_read", "clipboard_write",
  ];
  const s = stubApi(ALL);
  research(s.pi);
  host(s.pi);
  await s.handlers.get("session_start")!({}, { model: { id: "m", provider: "p" } });

  const after = s.activeTools();
  for (const tool of ["notify", "vault_read", "vault_write", "tasks_list", "propose_task", "clipboard_read", "clipboard_write"]) {
    assert.ok(after.includes(tool), `${tool} was dropped by the research extension`);
  }
  // And the built-ins it has no business touching.
  for (const tool of ["read", "bash", "edit", "write"]) assert.ok(after.includes(tool), tool);
});

test("a timed-out approval is reported as unknown, not as failure", async () => {
  // The action may well have gone ahead on a late click. Telling the model it
  // failed invites a retry, and a retry here means a duplicate task or event.
  await withBridge(
    () => { throw new Error("host request timed out after 1800000ms"); },
    async (tools) => {
      const out = await tools.get("propose_event").execute("1", { title: "x", start: "2026-08-25" });
      const text = out.content[0].text;
      assert.match(text, /may or may not have gone ahead/i);
      assert.match(text, /Do not repeat it/i);
    },
  );
});
