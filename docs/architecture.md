---
layout: default
title: Architecture
nav_order: 17
---

# Architecture

For anyone reading the code, reviewing the security model, or deciding
whether to trust this thing with a meeting recording.

One process tree. No daemon beyond the local model runtime MyRA itself
supervises, no container, no VM.

```
Electron main                       Renderer (sandboxed)
├─ agent loop  ── the only LLM caller ├─ chat · tool cards · citations
│   └─ tool registry, 19 tools        ├─ meeting capture (getUserMedia)
├─ core/       pure TS, no electron   └─ settings
│   ├─ audio      speech · voices · what is worth reading aloud
│   ├─ images     prompts · sizes · where a picture is filed
│   ├─ diagrams   Mermaid parsed, laid out, drawn — never executed
│   ├─ prisma     the 2020 box model, one spec for the form and the figure
│   ├─ library    Zotero: local API, then the database file
│   ├─ sources    a project's own uploaded papers, FTS5 search
│   ├─ meetings   merge · prompts · verify
│   ├─ projects   the index, memory notes, grounded auto-writes
│   ├─ research   OpenAlex · arXiv · PubMed · CORE · S2 · hydrate · pdf
│   ├─ documents  pandoc argv · path jail
│   └─ llm        one HTTP client, OpenAI-shaped
└─ pandoc      fetched into your data directory on first use, not bundled
```

## The tool registry is the security boundary

There is no `bash`, so "run a command" is not something the protocol can
express — the model can only emit a call matching a schema in
[registry.ts](https://github.com/noah-schroeder/myra/blob/main/src/core/agent/registry.ts),
and that list is the complete set of things the agent can do.

Two rules hold that boundary up, and neither may be relaxed:

1. **Tools build their own argv from a fixed template.** pandoc's
   `--lua-filter` executes arbitrary code, so a passthrough argument would
   be a shell with extra steps.
2. **Every path is resolved and jailed on every call**, with `realpath`,
   after normalisation — so a symlink pointing out of the jail is caught.

The [threat model](threat-model.html) sets out what that boundary does and
does not cover, including the parts MyRA does not defend against — there is no
OS-level sandbox around the main process, and the page says why.

## The local model runtime

MyRA runs local models through a bundled runtime called **Lemonade**,
supervised directly from the main process: MyRA owns which model loads, and
guarantees nothing it starts outlives the app — including disabling the
runtime's own UDP broadcast, since a local assistant has no business
advertising itself to the network. The only listening socket the app itself
opens is the optional local API server, which is off by default, loopback
only, and refuses to start without a key.

## Documents and images follow the same shape

Both are written as: build the output under a temporary name, then rename
it into place, with any sidecar metadata written last. A listing enumerates
finished files by their sidecar, so an interrupted write leaves an orphan
file nothing shows — never a half-written result presented as finished.

## Further reading

- [CONTRIBUTING.md](https://github.com/noah-schroeder/myra/blob/main/CONTRIBUTING.md)
  — building from source and code conventions.
