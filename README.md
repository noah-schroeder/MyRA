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

**Research.** Searches OpenAlex and arXiv directly — and PubMed and CORE once you
add your own free key for each — resolves open-access full text through
Semantic Scholar, and can run a full plan → search → read → verify →
synthesise pipeline that produces a cited report.

**Projects.** A folder for one piece of work: put conversations, meetings,
research runs, papers, peer reviews and images in it, and while it is open
everything new files itself there. Delete it and its contents in one action — itemised first,
with the option to keep them. Nothing moves on disk; **Export** writes the whole
project out as one real folder, conversations rendered readable, which is also
what you would send a co-author.

**Paper drafter.** Turns raw, half-formed notes into first-draft academic prose
in **your own voice**: paste a sample of your writing, jot or dictate what you
want to say under each heading, and each section is written on its own. It does
not search and it **never cites** — the prompt forbids references, placeholders
and invented sources outright, and anything citation-shaped that appears anyway
is flagged rather than quietly removed. Work on a whole paper or on one section.

**Documents.** Drafts in Markdown and converts to Word, OpenDocument, HTML or
PDF, jailed to a folder you choose.

**Images.** Makes figures and illustrations from a description, with the model
chosen the same way the speech ones are, and files each into a folder you own
beside a note of what it was asked for.

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

**Speech** is two models rather than an endpoint: one that hears you and one
that speaks, both chosen from a list under Settings → Audio. The list holds
what the bundled runtime can run — Whisper and Moonshine for transcription,
Kokoro for the voice — and anything a provider you added offers. Dictation and
meeting transcription both use the first; the second is what reads answers
aloud in speech-to-speech mode, which is the wave button beside the microphone:
it listens, sends when you pause, answers out loud, and listens again until you
switch it off. Talking over an answer interrupts it.

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
- **Speech is the same choice made twice.** A transcription or voice model from
  the bundled runtime stays here; one from a provider you added means your
  recordings, or the answers Karen reads out, are sent to that provider. The
  picker says which it is, and the model chosen is named on screen.
- **Images go wherever their model is.** A model from the bundled runtime draws
  on this machine and the prompt stays here; one from a provider you added means
  the prompt is sent to that provider. The picker says which, and warns above the
  hosted ones.
- **Drafting a paper** sends the section you asked for — your writing sample,
  your notes and your instructions — to whichever model the bar names, and
  nothing else. A local model means it stays here. The prompt preview shows
  exactly what would be sent, and showing it sends nothing.
- **Scholarly searches** reach OpenAlex and arXiv, which need no key. PubMed and
  CORE are off until you add your own free key for each in Settings → Database
  keys; once added, a search that includes them sends your search terms and
  that key. Semantic Scholar is asked only whether a paper already found has an
  open-access PDF.
- **Pages you ask it to read** see a request from this machine.
- **Looking for a model** reaches Hugging Face, and only when you press
  something: Search sends what you typed, opening a result asks for that
  repository's details and its model card, and Download fetches the files.
  Typing in the box sends nothing. The registry is named, with its country, on
  every result and on every model's page.
- **Downloading a model** also asks Hugging Face for that model's `config.json`
  and `generation_config.json` — two small text files beside the weights — so
  Karen can size the context window to your machine rather than accept the
  daemon's 4,096, and can start from the sampler settings the model's authors
  published. Same host as the download itself, only when you download, and
  nothing is sent but the repository name. Loading a model afterwards asks
  nothing: what was learned is kept on this machine.
- **Checking for engine updates** asks GitHub which builds of llama.cpp,
  whisper.cpp and the rest have been released, and only when you press the
  button in Settings → Runtime. Karen never checks on its own, and installing
  one is a separate press.
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
│   ├─ audio      speech · voices · what is worth reading aloud
│   ├─ images     prompts · sizes · where a picture is filed
│   ├─ library    Zotero: local API, then the database file
│   ├─ meetings   merge · prompts · verify
│   ├─ research   OpenAlex · arXiv · PubMed · CORE · S2 · hydrate · pdf
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
