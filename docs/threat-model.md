---
layout: default
title: "Threat model: what contains the agent"
nav_order: 15
---

# Threat model: what contains the agent

Written to the same standard as [the privacy page](privacy.md): a security
claim is only honest if its edges are named. This page says what MyRA defends
against, what it does not, and which sentences here are checked by a test
rather than merely believed.

## What MyRA is

One process tree. An Electron main process, one window, and the child
processes MyRA starts — pandoc, `pdftotext`, `tar`, the Lemonade daemon, and
whatever inference engines that daemon starts in turn.

**There is no VM, no container, and no OS-level sandbox around the main
process.** That is a decision rather than an omission. MyRA needs the system
keyring, native directory pickers, Zotero's data directory and `~/Documents`;
a sandbox policy permissive enough to allow those four is permissive enough to
allow everything that matters. The honest answer was to make the in-process
boundary airtight and say plainly where it ends, which is this page.

The AppArmor profile in the `.deb` is electron-builder's boilerplate and reads
`flags=(unconfined)`. It exists to grant user namespaces back on Ubuntu 24.04
and later, so that Chromium's own sandbox works. It confines nothing.

## The boundary: the tool registry

The model cannot do anything that is not a tool. There is no `bash`, so "run a
command" is not expressible in the protocol — the model can only emit a call
matching a schema in [registry.ts](https://github.com/noah-schroeder/myra/blob/main/src/core/agent/registry.ts), and this is the
complete list.

| Tool | Risk class |
|---|---|
| `web_search` | `safe` |
| `fetch_page` | `safe` |
| `deep_research` | `safe` |
| `academic_research` | `safe` |
| `write_document` | `write` |
| `read_document` | `safe` |
| `convert_document` | `write` |
| `draft_document` | `write` |
| `search_library` | `safe` |
| `create_task` | `write` |
| `list_tasks` | `safe` |
| `complete_task` | `write` |

*Machine-checked.* `test/threatModel.test.ts` parses this table and compares it
to the registry, so a tool added without a row here fails `npm test`.

Two rules hold the boundary up and neither may be relaxed:

1. **A tool builds its own argv from a fixed template.** pandoc's
   `--lua-filter` executes arbitrary code, so a passthrough argument would be a
   shell with extra steps. Pinned by `test/jail.test.ts`.
2. **Every path is resolved and jailed on every call**, with `realpath`, after
   normalisation. Pinned by `test/jail.test.ts` and `test/docs.test.ts`.

Note what the risk classes mean in practice for this tool set: nothing is
classified above `write`, and `write` auto-approves in the default mode. **So
the approval prompt never fires during ordinary use.** The jail is what is
actually containing the agent, not the permission dialog. That is why the
jail's tests are the ones that matter.

## What the agent can reach

- `<workspaceRoot>/documents`, through `resolveInJail` — read, write, convert.
  Nothing above it, and no path outside it, on any of the three platforms MyRA
  ships to.
- The research root, for runs it creates. The directory name is a slug of the
  question, reduced to `[a-z0-9-]`.
- MyRA's own task store, a flat directory of JSON files in MyRA's own folder.
- The network, only through `fetch_page` and the four scholarly APIs in
  `databases.ts`. `fetch_page` refuses loopback, private, link-local and CGNAT
  addresses **after** resolving them, which covers the cloud metadata endpoint
  and DNS rebinding at resolve time. Pinned by `test/guard.test.ts`.
- The Zotero library, read-only, and never the live SQLite file.

## What the agent cannot reach

- **Command execution.** No tool takes a command, a shell string, or an
  argument that reaches a command line. `test/research.test.ts` pins that
  `bash` and `write_file` are unknown tools.
- **An arbitrary URL.** See above.
- **The keyring.** `secrets.ts` is main-only and no tool calls it.
- **Settings.** No tool writes configuration, so the model cannot move its own
  jail.
- **Another local account's files.** Directories MyRA creates are `0700` and
  files `0600`, asserted under a `0000` umask by `test/privacy.test.ts`.

## What is trusted

**The main process, completely.** It holds the keyring, the filesystem and all
network egress. Nothing in MyRA defends against a compromised main process.

**Every binary MyRA downloads, once installed.** pandoc, the Lemonade daemon
and the inference engines run as you, with no confinement. What MyRA does
promise is that it will not install one it cannot verify — see the supply chain
below.

**The renderer is trusted but checked.** It runs with `sandbox: true`,
`contextIsolation: true` and `nodeIntegration: false`; it makes no network
requests at all, because `onBeforeRequest` denies everything but the dev
server; and nothing in it builds HTML from a string — Markdown is rendered
from marked's lexer into React elements, pinned by
`test/markdown-safety.test.ts` — so model output cannot become script.

Its IPC arguments are nonetheless validated in main, and the reason is worth
stating rather than assuming: a future `innerHTML`, a renderer escape, or the
local API server growing a route would each turn "the window would never send
that" into a false premise. Every id that lands in a path is asserted, every
configurable folder is rebuilt rather than spread, and every reveal resolves
before it acts.

## What MyRA does not defend against

- **A compromised main process**, as above.
- **Another process running as you.** The `0700` directories defend against a
  *different* local account, which is the case a shared lab or university
  laptop actually has. They do not defend against something already running
  under your own user.
- **A hostile pandoc or lemond after installation.** The checksum is checked
  once, at install.
- **A residual race on document writes.** `write_document` creates its file
  under an unguessable name with `O_EXCL` and renames it into place, so a
  symlink planted at the target between resolution and use is replaced rather
  than followed. What remains is the *parent* directory: swapping an
  intermediate directory for a symlink in the same window would still land the
  file elsewhere. Closing that needs `openat`/`O_DIRECTORY` walking, which Node
  does not expose. The precondition is write access inside a directory created
  `0700` — i.e. already you — or a workspace you deliberately pointed at a
  shared or synced folder.
- **A model that lies.** Tool output is wrapped in untrusted markers and
  citations are checked, but a fabrication inside an answer is a quality
  problem, not a containment one.

## Prompt injection, specifically

A fetched web page, a search snippet and somebody else's manuscript are all
text written by strangers, and all three reach the model.

**Injection cannot widen what the agent can do. It can only misuse what the
agent may already do.** There is no instruction in a web page that adds a tool,
removes the jail, or reaches a shell, because none of those is expressible.
What injected text can do is ask for a document to be written, a page to be
fetched, or a search to be run — the same things you can ask for.

What holds: the jail, the URL guard, the permission mode, and the untrusted
markers that tell the model where the stranger's text begins. What does not:
nothing stops a model acting on injected text within its allowed capabilities.

## Supply chain

Everything MyRA downloads at runtime is verified before it is used:

- **The Lemonade daemon** — pinned by sha256 in `src/core/runtime/lemonade.ts`,
  recorded when the version was chosen rather than read from the same host that
  serves the bytes. A version bumped without its hashes fails `npm test`.
- **pandoc** — verified against the digest GitHub publishes for the release
  asset. No digest means MyRA declines to install it and falls back to whatever
  is on your `PATH`.
- **The bundled C runtime** — pinned by its OCI digest.
- **Model weights** — verified against the hashes Hugging Face publishes.

Archives are extracted with `--no-same-owner --no-same-permissions`, so a
tarball cannot restore a setuid bit or widen a directory MyRA created `0700`.

## Reporting a vulnerability

See [SECURITY.md](https://github.com/noah-schroeder/myra/blob/main/SECURITY.md) in the repository: use GitHub's private
vulnerability reporting rather than a public issue.
