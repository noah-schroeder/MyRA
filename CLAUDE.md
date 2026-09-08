# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install            # .npmrc sets ignore-scripts=true — deliberate, do not relax
npm run dev            # electron-vite dev (npm run dev:x11 forces X11 under Wayland)
npm run build          # compile to out/
npm run typecheck      # BOTH projects: tsconfig.node.json and tsconfig.web.json
npm test               # node:test over test/*.test.ts
npm run deb            # Linux .deb;  npm run dist  builds for the current platform
```

Run one test file, or one test:

```bash
node --test --experimental-strip-types --no-warnings --import ./test/setup.ts test/jail.test.ts
node --test --experimental-strip-types --no-warnings --import ./test/setup.ts \
     --test-name-pattern "escape vectors" test/jail.test.ts
```

`test/setup.ts` must stay in the `--import` position: it points `KAREN_CONFIG_DIR`,
`KAREN_RESEARCH_CONFIG` and `KAREN_RESEARCH_ROOT` at a temp dir *before* module load.
`CONFIG_DIR` in [paths.ts](src/core/paths.ts) is bound at import time, so setting those
inside a test is too late and the test reads the developer's live app state.

There is no bundler in the test path: TypeScript runs through Node's type stripping.
That is why every import carries its `.ts` / `.tsx` extension and why no file may use
syntax that needs emit (constructor parameter properties, enums, decorators).

## Architecture

Electron, one process tree, no daemon.

- **`src/core/`** — pure TypeScript. Must never import `electron`; a module that does
  cannot be loaded by the test runner at all. Everything worth testing lives here.
- **`src/main/`** — Electron: window, IPC handlers, keyring, child processes, the
  local runtime, the API gateway.
- **`src/preload/index.ts`** — the renderer's entire view of the outside world. Built
  as **CommonJS with a `.cjs` extension** (see the comment in
  [electron.vite.config.ts](electron.vite.config.ts)); a sandboxed preload cannot be ESM,
  and the failure is silent — every `window.karen` call is `undefined`.
- **`src/renderer/`** — React 19, `sandbox: true`, `contextIsolation: true`. It makes
  **no network requests**: `onBeforeRequest` default-denies everything but the dev
  server, and blocked attempts are counted and shown in Settings.
- **`src/shared/`** — the few rules both sides must agree on, imported by main *and*
  renderer. [safeUrl.ts](src/shared/safeUrl.ts) is the pattern: if the renderer were the
  stricter of the two, a URL reaching `shell.openExternal` by another route would still
  be opened, so there is one allowlist and both call it.

The main build does **not** bundle its dependencies (`externalizeDepsPlugin` is
load-bearing — bundling wedged v1 into a listening-but-never-accepting state).

### The tool registry is the security boundary

[registry.ts](src/core/agent/registry.ts) plus [tools/](src/core/agent/tools/) is the
complete list of what the agent can do — there is no `bash`, so "run a command" is not
expressible. Two rules hold it up and are not negotiable:

1. **A tool builds its own argv from a fixed template.** Never splice a model-chosen
   string into a command line; pandoc's `--lua-filter` executes arbitrary code.
2. **Every path is resolved and jailed on every call**, with `realpath`, after
   normalisation (`resolveInJail`). [test/jail.test.ts](test/jail.test.ts) attacks it
   with six vectors; keep it passing.

Risk class is declared **on the tool definition**, not in a side table (v1's side table
drifted and misclassified a renamed tool). The matrix lives in
[policy.ts](src/core/policy.ts); `catastrophic` and `system_of_record` are a hard floor
that no permission mode lowers. The agent loop
([loop.ts](src/core/agent/loop.ts)) knows nothing about modes or risk — it takes a
yes/no from `approve`.

Compaction lives beside it in [compact.ts](src/core/agent/compact.ts), under two rules.
**Compact the request, never the transcript** — the session file and the thread on screen
keep every message as it happened, so a longer window later can still use the full history.
And **never orphan a tool result**: a `tool` message without the `assistant` message
carrying its `tool_call_id` is a protocol error most servers reject wholesale, so the split
point is found by walking backwards to a boundary where no result is left without its call.

### The research ladder

[ladder.ts](src/core/research/ladder.ts) defines one ordered ladder —
`off → assistant → library → web → deep` — and gates are written as
`reaches(mode, "web")`, never as a list of modes. Adding a rung means placing it in the
array; a gate spelled `mode !== "off"` is the bug this replaced. Two gates use `exactly`
instead, because Quick and Deep are exclusive rather than cumulative. The ladder holds no
`node:fs` import so the renderer can share it.

### The deep-research pipeline

[pipeline.ts](src/core/research/pipeline.ts) orchestrates eleven stages
(`scope, plan, discover, screen, snowball, retrieve, extract, synthesize, verify, review,
revise`). Two rules give resumability for free:

1. Each stage reads the previous stage's output **from disk** and writes its own;
   nothing passes in memory.
2. A stage whose output file exists is skipped.

A stage's output file *is* its done-marker, so a long stage appends to `<name>.partial`
and `finalize()` renames it into place ([run.ts](src/core/research/run.ts)) — writing the
real name directly would make a crashed stage look complete. `finalize` on an empty
partial still writes the file: "found nothing" is a finished stage, not a missing one.

Stages are assigned to models by role
([roles.ts](src/core/research/roles.ts)): screener, analyst, synthesist, reviewer, plus a
separate embeddings model.

**Everything the pipeline asks a person happens in its first two stages**, and that is a
promise rather than an accident: a run takes minutes, so approving the plan and walking
away has to be a supported way to use it. Two rules keep it true. `deep_research` and
`academic_research` run **once per turn** — the model is otherwise free to call the tool
again after reading its own report, and did, three times on one question, each time
creating a new run and so re-asking every scoping question. And the stage list in
[stages.ts](src/core/research/stages.ts) is pinned by a test to the pipeline's own
`checkpoint()` calls, because the window draws the run from it.

### Meetings

The other long-running subsystem, and it earns its rules the same way the pipeline does.

**Capture belongs to the renderer, the file belongs to main.** `getUserMedia` (plus
`getDisplayMedia` for the far side of a call) downsamples to mono 16 kHz s16le and pushes
chunks over IPC; [capture.ts](src/core/meetings/capture.ts) owns the WAV and therefore its
header. v1 spawned `pw-record` per track, which worked only under PipeWire and only if
SIGTERM — never SIGKILL — reached the child, or the header was never finalised.

**Two tracks, not diarization.** Microphone plus the output sink's monitor is what makes
"who committed to this" answerable. [transcript.ts](src/core/meetings/transcript.ts)
interleaves them by time and removes acoustic bleed — on speakers the microphone records
the far side too, and a transcript that says everything twice is worse than one track.

**Nothing is transcribed while recording**, and tracks are transcribed one after another
([meetingRun.ts](src/core/meetings/meetingRun.ts)): on an 8 GB card the transcription
model and the model that writes the notes are not both resident, and two concurrent
Whisper passes OOM at the end of a meeting that cannot be re-recorded.

**Notes are two passes with a verification step between them**
([notes.ts](src/core/meetings/notes.ts)): extract grounded items, look every quote up in
the transcript, then compose. The item's timestamp is taken from the line actually found —
a model that reconstructs a quote reconstructs its timestamp too, so its own `at` is never
believed. Unsourced claims are filed under `## Unverified` rather than stated.

**The meeting directory is the record.** Each stage leaves its own artifact
(`meeting.json`, the WAVs, `karen.json`, `transcript.json`, `transcript.md`, `notes.md`);
[store.ts](src/core/meetings/store.ts) reads a directory to decide which buttons to offer.
Re-running notes with a different prompt must not re-run transcription, and a meeting whose
transcription failed must not vanish while its audio sits on disk.

### Projects

A project is an **index, not a folder** ([project.ts](src/core/projects/project.ts)): it
lists the five kinds of thing Karen makes — `chat | meeting | run | paper | image` — and
the files never move. A real directory per project was costed and rejected, and will be
proposed again: as soon as items live in different directories every "open this by id"
call has to first discover *which* directory holds it, so that design needs this index
anyway — and on top of it the research root would have to be threaded through the
pipeline and its resume logic, the meetings jail widened past `meetingsRoot`, and
conversations moved out of `~/.config` into a directory a file manager and any cloud sync
can read.

"All of it together on disk" is a real want, and it is answered by **exporting** a folder
rather than by living in one. [render.ts](src/core/projects/render.ts) decides what goes
where and returns a list of `ExportOp`s; [projects.ts](src/main/projects.ts) performs
them — so the layout, the naming and the collision handling are testable with no disk and
no Electron. The destructive half is split into
[projectStore.ts](src/main/projectStore.ts) for the reason `modelDelete.ts` is split from
its own IPC: a module that imports `electron` cannot be loaded by the test runner at all,
and deleting is exactly the path that has to be tested. A store joins by satisfying
`KindStore` — `list`, `remove`, `payload` — which is the only thing a project may assume
about one.

### The paper drafter

Ported in substance from Braindump5000, which was tuned against real use before it got
here: paste a sample of your own academic prose, jot or dictate raw notes under each
heading, and each section is written on its own in that voice
([prompt.ts](src/core/papers/prompt.ts)). Two things about that prompt are not decoration.
**The writing sample is the point** — the outline, the preceding section and the notes are
all context for it. And **citations are forbidden outright and unconditionally**: nothing
in this flow searches, so every reference a model produces here is invented by
construction. The original tool's "power-user mode" replaced the whole prompt, guardrails
included, and is deliberately not carried over — this would be the one place in the app
where a fabricated authority is allowed. The author's own instructions, for the paper and
for one section, are **appended** to that prompt, never substituted for it.

Pure, so the preview dialog renders exactly what is sent, character for character, and
showing it sends nothing. "A whole paper" and "one section" are one record and one shape
([paper.ts](src/core/papers/paper.ts)), differing only in how many sections there are;
two shapes would be two save paths and two sets of bugs, and the second would be the one
nobody remembered to fix. A paper is a flat `<id>.json` beside the others rather than a
directory holding one file, and [store.ts](src/core/papers/store.ts) parses forgivingly
the way images/store.ts does — a list that throws on the fifth of twenty papers is worse
than one that skips it, and skipping is visible.

### Drafting a document

[draft.ts](src/core/documents/draft.ts) is outline, approve, then one section at a time,
and **the orchestration is code rather than the model's discretion**. A tool that merely
*invites* a model to plan first is a suggestion a 2.6B is free to decline, and it declines
by writing the whole document in one call — the failure this exists to prevent. Three
things fall out of the split: each request is small, which is where the quality win on a
local model comes from; context stays bounded however long the document gets, because a
section sees the outline and the tail of what came before rather than the whole draft; and
the file is saved after every section, so a run that dies at section eight leaves seven
sections on disk instead of nothing.

### The Zotero library

A different question from `academic_research`: the few hundred papers the user has already
decided matter, with metadata they have already corrected — so it sits at the `library`
rung, below anything that leaves the machine. Two ways in, in this order:

1. **Zotero's local HTTP API** ([zotero.ts](src/core/library/zotero.ts)), port 23119, no
   key. Both loopback addresses are tried — `localhost` is 127.0.0.1 *and* ::1, and Karen
   dialling only v4 reported a plainly-running Zotero as absent. Never resolved through
   `localhost` itself: that would make the address depend on `/etc/hosts`.
2. **`zotero.sqlite` directly** ([zoteroDb.ts](src/core/library/zoteroDb.ts), executed by
   [zoteroSqlite.ts](src/main/runtime/zoteroSqlite.ts)), when nothing answers the port — a
   Flatpak or Snap Zotero keeps the port in its own network namespace while its data
   directory sits on the ordinary filesystem. **Never write, and never open the live
   file**: Zotero holds it in WAL mode, so the read is against a snapshot taken with
   SQLite's backup API. A plain file copy tears pages whenever Zotero syncs mid-search.

Where the library lives is *read* from Zotero's own `prefs.js`
([zoteroProfile.ts](src/core/library/zoteroProfile.ts)), not guessed from a candidate list
— a moved data directory otherwise produces "Zotero is not reachable", the message for an
entirely different problem. As everywhere in core, the pure half (SQL, parsing, candidate
paths) is split from the half that touches a disk, so it is testable with no Zotero
installed.

### Models and endpoints

[chat.ts](src/core/llm/chat.ts) is the only place the app talks to a language model
(OpenAI-shaped, streaming, plus `runSubagent` for one-shot stage work). A model reference
is `provider/id`, resolved through [providers.ts](src/core/providers.ts) to an endpoint.

The local backend is **Lemonade**, supervised from
[main/runtime/](src/main/runtime/manager.ts); Karen owns which model to load and the
guarantee that nothing it starts outlives it — including `--no-broadcast`, since
`lemond` otherwise advertises itself over UDP and a local assistant has no business
announcing itself to the network. [api/server.ts](src/main/api/server.ts) is
the only listening socket: off by default, loopback, refuses to start without a key, and
forwards only the paths in [core/api/routes.ts](src/core/api/routes.ts).

Lemonade downloads its engines per recipe (`llamacpp`, `whispercpp`, `kokoro`,
`sd-cpp`) and **starts them itself**, which is a problem Karen has to solve from the
outside: measured on the released builds, `whisper-server` v1.8.4 and kokoro's `koko`
b17 need `GLIBC_2.38` while `llama-server` b10375 needs 2.34 — so on Ubuntu 22.04 chat
works and every speech model exits code 1 within a tenth of a second. Karen already
carries a newer glibc for `lemond` on such a machine, so
[engineRuntime.ts](src/main/runtime/engineRuntime.ts) copies it into each engine's
directory and replaces the binary with a script that `exec`s it through that loader.
`exec`, because Lemonade kills the engine by the pid it spawned; and the loader goes
**in the engine's own directory**, because ggml finds `libggml-vulkan.so` relative to
`/proc/self/exe`, which under a bundled loader is the loader.

Every model that is **not** the chat model — transcription, voice, image — goes through
one resolver and one lister ([main/models.ts](src/main/models.ts)): a bare id is the local
daemon, `provider::model` is one of the user's providers, and the routing rules exist once
because a second copy that drifts is a privacy bug rather than an inconsistency. Anything
asking "is this model external" asks `choiceIsExternal` with the settings in hand, never a
model list fetched lazily — a picker that had not opened its menu yet reported a hosted
model as local, in the app's own colour for "this stays on your machine".

Speech models are referenced the same way and resolved in exactly one place
([main/audio.ts](src/main/audio.ts)) for dictation, meetings and hands-free alike; which
models can hear or speak is read off the `labels` array on `/api/v1/models`
([core/audio/](src/core/audio/models.ts)), not guessed from the id — `/whisper|moonshine/i`
was already wrong for anything renamed. A reference naming a deleted provider is an error,
never a quiet fallback to something local: audio is a recording of a room.

A provider's `local`/`external` label may only make Karen **more** cautious: an endpoint
that is not on this machine is external whatever the label says
([destinations.ts](src/core/destinations.ts) owns that rule, and the privacy report reads
the same function).

### The model catalogue

Lemonade's `/models` lists only what is registered or already downloaded — three things on
a fresh machine — so the catalogue proper is read from `resources/server_models.json`
inside the install ([catalog.ts](src/core/runtime/catalog.ts)): it needs no network, and it
carries the two fields the daemon's API does not return. `size`, without which "will this
fit in your VRAM" has no input; and `labels`, which is the only thing separating a chat
model from a speech or image one, since Lemonade serves all of them through one API.

Whether it fits is [fit.ts](src/core/runtime/fit.ts), and the naive version — file size
against VRAM — is wrong exactly on the machines people care about, because **the KV cache
is not in the file size**: over 3 GB for a 48-layer model at 32k context, more than the gap
between two quantisations, so the list confidently recommends a model that then fails to
load. [registry.ts](src/core/runtime/registry.ts) owns identity and provenance for both the
catalogue and the search UI, which must never disagree: **the country is part of the name**
(`Hugging Face [US]`, not a tooltip or an icon), and every result carries its origin even
now that they all share one — a badge shown only on exceptions makes an unlabelled row mean
either "the usual one" or "nobody checked". [foreign.ts](src/core/runtime/foreign.ts)
offers the GGUFs the user already downloaded with LM Studio or Ollama, as a directory of
symlinked **files**: Lemonade takes one hint about models it did not fetch itself
(`extra_models_dir`), it names a model after the leaf directory, and it skips symlinked
*directories* silently — so pointing it at `~/.lmstudio` does not work.

### Images

The third model role, and the one with files. [main/images.ts](src/main/images.ts) owns the
disk, [core/images/](src/core/images/generate.ts) the request and the naming, and the two
rules are the pipeline's rules again:

1. **The sidecar is the done-marker.** The picture is written under a temporary name and
   renamed into place, the JSON beside it is written last, and a listing enumerates
   sidecars — so an interrupted generation leaves an orphan file nothing shows, never a
   half-written picture presented as finished.
2. **The prompt becomes a filename, so it is slugged and then asserted.**
   `assertImageId` is `assertRunId` for the same reason: the id comes back from the
   renderer to be deleted, revealed and re-read.

One generation at a time, deliberately — two diffusion passes on an 8 GB card is the
out-of-memory failure meetings already avoids by transcribing serially. The timestamp in a
filename is the **local** clock, because that name is read in a file manager beside the
modification time that manager prints.

### Settings, secrets, IPC

All settings go through [config.ts](src/core/config.ts) and are edited only in the GUI —
"the user should never open a JSON file" is a product requirement, so anything
configurable belongs in that shape. API keys never appear there: they go to the OS
keyring via [secrets.ts](src/main/secrets.ts), which refuses to persist when Electron
falls back to its hardcoded-password encryption.

IPC channels are all `karen:*` — around 150 of them, registered in
[main/index.ts](src/main/index.ts)'s `installIpc` and in the eight `install*Ipc` modules it
calls (meetings, dictation, audio, images, papers, projects, runtime, api), and exposed
one-by-one in the preload. Adding a capability means touching all three layers plus
`src/renderer/types.ts`, and at that scale a channel wired in only three of the four is a
`window.karen` call that is `undefined` at runtime.

Directories Karen creates are `0700` and files `0600` (`makePrivateDir` / `makeOwnDir` in
paths.ts) — transcripts and drafts must not be readable by another local account. A
directory the *user* chose is never re-chmodded. [test/privacy.test.ts](test/privacy.test.ts)
asserts this under a `0000` umask.

## Conventions

- Comments explain **why**, usually naming the concrete failure that motivated the code.
  Match that register; a comment restating the line below it is noise here.
- Commit subjects are sentences about behaviour ("Ask the provider whether it sends
  reasoning, instead of guessing"), not `type(scope):` prefixes.
- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and
  `verbatimModuleSyntax` are on; `| undefined` is written explicitly where a field must
  be clearable.
- Runtime dependencies are `katex` and `marked` only. Adding one to the main process is a
  supply-chain decision, not a convenience.
- No telemetry, no auto-updater, no remote assets, spellchecker off. If a change makes
  the app fetch something at runtime, it needs a line in the README's "What leaves this
  machine".

## Design docs

[PLAN.md](PLAN.md) build plan and threat model · [DECISIONS.md](DECISIONS.md) open
judgment calls · [PORT.md](PORT.md) what came from the VM-based v1 ·
[RESEARCH-REWORK.md](RESEARCH-REWORK.md) the pipeline's current direction ·
[RUNTIME-PLAN.md](RUNTIME-PLAN.md) local inference · [API-PLAN.md](API-PLAN.md) the
gateway · [DISTRIBUTION.md](DISTRIBUTION.md) packaging and the macOS signing decision.
