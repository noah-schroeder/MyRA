# Karen

A private, local-first assistant for academic work: meeting notes, research
synthesis, and document drafting. Everything runs on your own machine, and the
only things that leave it are the requests you configure it to make.

## What it does

**Meetings.** Records two tracks — your microphone and the system's own output —
which is what separates the speakers without a diarization model. Transcribes
both, merges them, and writes a report where **every claim is checked against the
transcript**. Anything it cannot source is filed under `## Unverified` rather
than stated.

**Research.** Searches OpenAlex, arXiv, Crossref and Semantic Scholar directly,
resolves open-access PDFs, and can run a full plan → search → read → verify →
synthesise pipeline that produces a cited report.

**Documents.** Drafts in Markdown and converts to Word, OpenDocument, HTML or
PDF, jailed to a folder you choose.

## Running it

    npm install
    npm run dev

Build a package:

    npm run build      # compile
    npm run deb        # Linux .deb
    npm run dist       # the platform you are on

Tests and typechecks:

    npm test
    npm run typecheck

## Configuration

All of it is in Settings; you should never need to open a JSON file. Point the
endpoints at whatever speaks the OpenAI API — llama.cpp, Ollama, vLLM, or a
hosted provider. API keys go to the OS keyring, never to disk in the clear.

Document conversion uses **pandoc**, bundled per platform — it is what gives you
CSL citation styles, bibliographies and journal templates. It is not required to
run: without it, documents are written as Markdown and everything else works
normally. PDF output goes through HTML and the app's own browser engine, so
there is no LaTeX toolchain to install.

## What leaves this machine

Stated plainly, because a privacy claim is only honest if its edges are named:

- **Your prompts and audio go to the endpoints you configured.** Point them at
  localhost and nothing leaves. Point them at a hosted API and that traffic goes
  there. The app cannot change that.
- **Scholarly searches** reach OpenAlex, arXiv, Crossref and Semantic Scholar.
- **Pages you ask it to read** see a request from this machine.
- Everything else — files, transcripts, meeting audio, conversation history —
  never crosses the network at all.

There is no telemetry, no auto-updater, no crash reporting, and no remote assets:
the content security policy is `default-src 'self'` and the spellchecker is
disabled because Chromium otherwise fetches dictionaries from Google.

## Architecture

One process tree, no daemon, no container, no VM.

```
Electron main                       Renderer (sandboxed)
├─ agent loop  ── the only LLM caller ├─ chat · tool cards · citations
│   └─ tool registry ~8 tools         ├─ meeting capture (getUserMedia)
├─ core/       pure TS, no electron   └─ settings
│   ├─ meetings   merge · prompts · verify
│   ├─ research   OpenAlex · arXiv · S2 · hydrate · pdf
│   ├─ documents  pandoc argv · path jail
│   └─ llm        one HTTP client, OpenAI-shaped
└─ vendor/     pandoc, pdftotext — bundled per platform
```

**The tool registry is the security boundary.** There is no `bash`, so "run a
command" is not something the protocol can express — the model can only emit a
call matching a schema in [registry.ts](src/core/agent/registry.ts), and that
list is the complete set of things the agent can do.

Two rules hold that boundary up, and neither may be relaxed:

1. **Tools build their own argv from a fixed template.** pandoc's `--lua-filter`
   executes arbitrary code, so a passthrough argument would be a shell with
   extra steps.
2. **Every path is resolved and jailed on every call**, with `realpath`, after
   normalisation — so a symlink pointing out of the jail is caught.

See [PLAN.md](PLAN.md) for the build plan and threat model, [PORT.md](PORT.md)
for what came across from the VM-based v1, and [DECISIONS.md](DECISIONS.md) for
the judgment calls that are still open.
