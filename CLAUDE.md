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

`test/setup.ts` must stay in the `--import` position: it points `MYRA_CONFIG_DIR`,
`MYRA_RESEARCH_CONFIG` and `MYRA_RESEARCH_ROOT` at a temp dir *before* module load.
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
  and the failure is silent — every `window.myra` call is `undefined`.
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

### Scholarly search has no container

v1 routed every query, scholarly or general, through a SearXNG instance the user had to
install and run — the heaviest prerequisite in the project, and the weakest link for
academic work: SearXNG flattens every result to `{url,title,content,engine}`, throwing
away the citation graph and the open-access PDF links deep research runs on. Scholarly
search now goes straight to the APIs: OpenAlex and arXiv need no key, PubMed and CORE do.
[databases.ts](src/core/research/databases.ts) is the single list of the four, has no
imports so the renderer can read it too, and a test pins it against the provider list
actually queried — a database added or dropped shows up on the bar or the suite fails.
[providers.ts](src/core/research/providers.ts)'s `resolveProviders` turns "these four are
chosen" into "these of them are actually usable right now".

A keyed provider ([coreApi.ts](src/core/research/coreApi.ts),
[pubmed.ts](src/core/research/pubmed.ts)) asks
[keys.ts](src/core/research/keys.ts) for its secret rather than reading a keyring
directly — `src/core/` must never import `electron`, so main installs a reader thunk at
startup, the same shape `setEndpointResolver` already uses. No reader installed means no
key, never a request with an empty `Authorization` header read back as an outage; tests
that never call `setDatabaseKeys` get that behaviour for free. A key is read at request
time, never cached in `keys.ts` itself, so one entered in Settings works on the very next
search with no restart.

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
(`meeting.json`, the WAVs, `myra.json`, `transcript.json`, `transcript.md`, `notes.md`);
[store.ts](src/core/meetings/store.ts) reads a directory to decide which buttons to offer.
Re-running notes with a different prompt must not re-run transcription, and a meeting whose
transcription failed must not vanish while its audio sits on disk.

### Projects

A project is an **index, not a folder** ([project.ts](src/core/projects/project.ts)): it
lists the six kinds of thing MyRA makes — `chat | meeting | run | paper | review | image`
— and the files never move. Adding a kind means moving six enumerations together
(`MemberKind`/`MEMBER_KINDS`/`KIND_WORDS`/`countsOf`, render.ts's `FOLDERS`/`HEADINGS`/
`ORDER`, `defaultStores`, and the two renderer tables); `asMembers` validates against
`MEMBER_KINDS` rather than a chain of literals, because that chain was the one place a new
kind could be added everywhere else and still be dropped silently. A member's `ref`
is validated by the store that owns it, through `assertRef` on `KindStore` — on the
interface for the reason risk class is on the `ToolDef`: widening `MemberKind` makes
`ProjectStores` demand a seventh store, which does not compile without one. Meetings
are why it is there, being the only kind addressed by directory name rather than by
an id, and `stores.meeting.remove` is `rm -rf`. A real directory per project was costed and rejected, and will be
proposed again: as soon as items live in different directories every "open this by id"
call has to first discover *which* directory holds it, so that design needs this index
anyway — and on top of it the research root would have to be threaded through the
pipeline and its resume logic, the meetings jail widened past `meetingsRoot`, and
conversations moved out of `~/.config` into a directory a file manager and any cloud sync
can read.

**Filing something into a project takes it out of the rail's Recent list.** The list shows one
group at a time — the project you are in, or the work that is in no project — and never both,
which is what makes "Delete all conversations" beside it a broom for loose work rather than a
button that empties a project it never named. Main enforces the same rule rather than trusting
the window's filter: `deleteAllSessions` takes the set `filedRefs("chat")` returns and spares
it, attachments included. `myra:recent` returns both groups, each row carrying its project, and
its limit is counted **per project** (`perProjectLimit`) — a limit across the whole list would
let a morning's filing push every loose conversation out of a list that was never going to show
those rows.

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

### Project memory

Optional, and separate from the index above: a research project can carry notes —
research questions, aims, guiding theory, methods, decisions, open questions, context —
that every conversation filed to it can read, so the second conversation about a project
does not start by re-explaining the first. Creating a project offers a choice, "Simple
folder" or "Research project"; a simple folder can opt in later from its own page,
because having a memory file at all is what marks a project as research, not a flag fixed
at creation.

**A research project's first message runs a fixed wizard, not a free chat.** The same
"code runs it, not the model" discipline `documents/draft.ts` states for a reason:
`runProjectSetup` ([main/projectMemory.ts](src/main/projectMemory.ts)) shows a canned
greeting ([greeting.ts](src/core/projects/greeting.ts)), extracts what the description
already stated, offers help brainstorming research questions, guiding theories, scope,
methods or key literature, asks Socratic questions about whichever the user picks — the
[scope.ts](src/core/research/scope.ts) pattern of generated questions with 2–4 options,
"Other" and skip, reused here for the same reason it works there — and shows every
candidate note in a review form before saving anything. `SETUP_GREETING` lives in its own
zero-import file rather than in [intake.ts](src/core/projects/intake.ts) alongside the
rest of the wizard's prompts, because `intake.ts` reaches `core/llm/chat.ts` and, through
it, `node:fs/promises` — fine for main, fatal the moment the renderer needs the same
greeting before a message exists to ask main for it.

**Only the chat turn reads a project's memory**, the same rule the persona follows and
for the same reason: a research pipeline stage, the reviewer or a meeting reading a
project's notes could have them rewrite a PRISMA checklist or a review's house rules the
way an unwary custom persona could, and nothing downstream is built to guard against
that. `systemPrompt()` takes an optional `project` and renders its notes in one block,
never touched by `persona`.

**The memory is never capped for size; the prompt is, and only by a share of the actual
window.** [memory.ts](src/core/projects/memory.ts)'s `renderMemory` reads
`runtime.chatEndpoint()?.contextTokens` the same figure the context meter and compaction
already read. Past a quarter of it, the project page warns; past half, whole fields are
left out in priority order — questions and aims survive longest, context first — with
storage itself untouched, because a memory that fills the window fails every turn in the
project rather than costing one degraded reply. An unknown window (a hosted endpoint)
caps nothing, the same stance `needsCompaction` already takes.

**An automatic write has to be grounded in the user's own words.** The meeting notes
rule — every extracted item is looked up in the transcript before it is trusted — applied
to a conversation instead of a recording: [memoryUpdate.ts](src/core/projects/memoryUpdate.ts)
takes the model's candidate items and keeps only the ones `verifyQuote`
([transcript.ts](src/core/meetings/transcript.ts)) actually finds, two ways. **Stated**:
the quote is something the user wrote. **Confirmed**: the quote is something the
assistant proposed, and the very next message from the user agrees to it — code checks
the position, the model only judges whether the reply was a yes. `<<<UNTRUSTED
CONTENT>>>` blocks are stripped from every message first, so a fetched page or a dropped
document cannot plant a "memory" of its own; it can only reach memory by first reaching
an assistant reply that the user then actually confirmed. There is no third, unreviewed
pile — an item is grounded and kept, or it is dropped.

**The background pass and the button share the grounding, not the trust.** A quiet
conversation restarts a 90-second timer every turn; once it fires, `runAutoUpdate` grounds
and saves automatically, source `"auto"`. "Update project notes from this chat" runs the
identical extraction but shows a review form first, saving what is approved as `"you"` —
the same reviewed-versus-unattended split setup's own items (`"setup"`) already draw. An
automatic write can only add: editing an `"auto"` item turns it into a `"you"` item, and
nothing here ever overwrites what a person wrote or approved.
[work.ts](src/main/work.ts)'s lease and a resident-model check both gate the automatic
pass — a local model MyRA is not already holding must never be loaded just to write a
note, the exact reload `resolveLlm`'s own header warns against; a hosted choice has no
such card to spare and is always allowed to run, and so does the user's own endpoint,
which has nothing to load (`runtime.wouldLoadForChat()` is the question, not "is a local
model resident"). A pass that saves anything says so in the conversation it read, as a
notice: one that wrote notes where nobody was looking was indistinguishable from one that
never ran.

**`remember` is the third door, and it goes through the same grounding.** The idle pass
is right for what nobody pointed at and wrong for "remember that we're using grounded
theory", which someone says expecting to see it kept now. So the model has a tool
([tools/memory.ts](src/core/agent/tools/memory.ts)) whose note is saved only when its
`quote` passes `groundProposals` — injection can reach the tool and cannot get past it.
It is offered only in a project that has a memory file and `auto` on (a simple folder must
not become a research project because a model called a tool in it), and `addAuto` appends
without moving the conversation's `seen` watermark. Beside it, each turn in a project has a
**Remember** button that saves the message, or the part of it selected, as a `"you"` note:
the person's own action, so it is reviewed in the dialog rather than grounded.

**The setup chat streams, so its reasoning shows.** Each of its model calls is JSON nobody
reads, which on a local model meant minutes with nothing on screen. `runProjectSetup` takes
a `SetupOutput` — `say` for the narrative the conversation keeps, `think` for reasoning
that is shown and never kept, `progress` for the status row — and passes the chat turn's own
reasoning switch (`extra`) to `runSubagent`, which otherwise sends none.

**A separate file, in a subdirectory, never a project's own record.**
[memoryStore.ts](src/main/memoryStore.ts) keeps `projects/memory/<id>.json` beside
`projects/<id>.json` rather than as a field on it: `fileInActiveProject` rewrites a
project's own record after every turn, so a memory edit landing at the same moment could
lose that race against it; and the subdirectory keeps a memory file from being read back
as a project by `readAll`'s own `*.json` sweep of `projects/`. Deleting a project deletes
its memory; exporting one writes `memory.md` if there are any notes, using
`renderMemoryMarkdown` — full and uncapped, because that is read by a person, not sent to
a model, and the half-window rule has nothing to do with a document.

### Diagrams

A figure for a paper, drawn by a language model rather than a diffusion one —
because a diagram's whole content is exact text, precise arrows and reproducible
geometry, which is the one thing diffusion cannot do. `create_diagram`
([tools/diagram.ts](src/core/agent/tools/diagram.ts)) takes Mermaid flowchart
syntax and is `safe`: nothing it does touches a disk, and a file appears only
when a person presses Export.

**Mermaid is parsed, never run.** The package is 118 MB across 23 dependency
families against an app whose entire runtime dependency list is `katex` and
`marked`, and it renders by generating an HTML string — which
[Markdown.tsx](src/renderer/components/Markdown.tsx) already refuses in its
opening paragraph, since diagram source is model output and a model quotes the
open web. So [mermaid.ts](src/core/diagrams/mermaid.ts) reads the flowchart
subset, [layout.ts](src/core/diagrams/layout.ts) places it and
[svg.ts](src/core/diagrams/svg.ts) turns it into paths. Every label becomes the
text of a `<text>` node and can be nothing else. The model still writes Mermaid
because every model writes Mermaid; a schema MyRA invented is one a 2.6B
declines to follow, which is the failure `documents/draft.ts` exists to prevent.

**A tool rather than a code fence, and the repair loop is free.**
`ToolResult.content` is what the model reads, so a parse error returned from the
tool *is* the retry — the agent loop already re-calls a failed tool. What is not
drawable is refused by name (`sequenceDiagram`, subgraphs) rather than
half-drawn, because that message is what the model acts on.

**Colours are read, but only as colours.** `classDef`, `style` and `linkStyle`
are how a model does what a user means by "make the screening steps green", so
they are parsed — every value through [colors.ts](src/core/diagrams/colors.ts),
which returns `#rrggbb` from a hex code, `rgb()` or a CSS colour name and
nothing otherwise, so no string a model wrote reaches an SVG attribute. A value
that is not a colour is dropped and named in the tool's reply rather than
failing the diagram. A fill with no stated text colour gets near-black or white,
whichever has the better contrast; explicit colours beat the theme and the
category palette on screen and on export alike, and a filled category takes no
palette slot. A diagram that names no colour is byte-for-byte what it was.

**Looks are presets, not a theme editor.** [styles.ts](src/core/diagrams/styles.ts)
defines four — Standard, Journal (Helvetica/Arial, thin rules, Okabe–Ito tints, no
shadows), Poster (semibold, roomy, rounded boxes and elbows, heavier arrows, a stroke
per category) and Monochrome (Journal's geometry in greys, every chosen colour mapped to
the grey of the same lightness) — because a researcher should get a finished look by
picking a word, not by tuning a dozen sliders into something that is none of them. A
look has two halves: geometry (`Look`), which `layoutDiagram` takes because type size and
padding change where boxes go, and a palette (`DiagramTheme`), which only paints. Standard
places no `look` on its `Layout` and draws exactly what it always did, on screen from CSS
and on export from `PAPER_THEME`; a named look is drawn on screen in its export colours on
a white ground (WYSIWYG — a poster previewed in dark mode previews something else), both
through one shared [DiagramSvg.tsx](src/renderer/components/DiagramSvg.tsx) and the same
`nodeColors`/`edgeColors` the exporter uses. The model may name a look (`create_diagram`'s
`style`) when asked; the figure's Style menu always wins, rewrites that figure's style, and
is remembered for figures drawn without one. PRISMA figures take no look: their appearance
is the official template.

**One geometry, two consumers, two palettes.** The renderer maps `nodePath`/
`edgePath` onto React elements and colours them from CSS so the figure follows
the app's theme; `toSvg` writes the same strings into a file using
`PAPER_THEME`, which is always light — a figure exported in dark mode arrives in
a manuscript as white text on white. Arrowheads are drawn triangles, not
`<marker>` defs, because a marker is referenced by id and a thread holds several
diagrams. Text is **estimated, not measured** (0.58em per character): nothing
here has a DOM, so boxes are padded rather than fitted.

**PRISMA 2020, not the figure MyRA drew before.**
[prisma/spec.ts](src/core/prisma/spec.ts) is the box model — every box and row
the four official templates define, captions verbatim, one list read by both
the form that asks for the numbers and the layout that draws them, the way
[databases.ts](src/core/research/databases.ts) is the single list of the four
databases. The predecessor emitted 2009 wording ("Records identified through
database searching", "Full-text sources retrieved and assessed") that the 2020
statement replaced outright — a reviewer reads this figure against the
template they know, so the words mattered more here than anywhere else in the
diagram code. The old rule is now the spec's own: **a count nobody measured is
left out, never a box reading zero** — a blank field omits its row, a typed 0
draws `(n = 0)`, and a box whose rows are all blank is not built at all.

**A second placer, because `layoutDiagram` cannot draw this.**
[prisma/layout.ts](src/core/prisma/layout.ts) builds a `Layout` by hand —
pinned columns, a side box hung at its parent's own vertical centre, phase
bands turned a quarter turn down the left edge, left-aligned lists inside a
box — none of which the general layered placer has any way to express. It is
still a `Layout`, though, which is the point: `toSvg`, `DiagramView.tsx`, Save
SVG/PNG and Copy figure all work on a PRISMA figure with no code of their own,
because [diagrams/layout.ts](src/core/diagrams/layout.ts) and
[svg.ts](src/core/diagrams/svg.ts) gained exactly one optional `box: BoxStyle`
field (corner radius, an inset for left-aligned text, a tint, a text turn)
that `layoutDiagram` never sets — a model-drawn diagram is the same bytes it
was before PRISMA existed, which is what pins `test/diagramSvg.test.ts`'s
byte-identity test.

**The tool asks, twice, then shows a form — never a model's arithmetic.**
`create_prisma_diagram` ([tools/prisma.ts](src/core/agent/tools/prisma.ts)) is
`safe` for the reason `create_diagram` is, and shares the research pipeline's
own dialogs (`setPrismaHost`, mirroring `setResearchHost`) for the reason the
paper drafter already does: "MyRA is asking me something and will produce work
once I answer" is one experience. Two choice questions settle which of the
four templates applies (new or updated review; databases only or also other
methods), then one form shows every field the chosen template needs, grouped
by phase. A model may pass counts it read in the conversation, but every one
reaches the form **marked as a guess, not drawn** — this figure is what an
editor checks a review against, and a hallucinated count sitting in a filled
field is easy to accept without reading. Cancelling any step is a returned
refusal rather than a thrown error, `deep_research`'s own reasoning for its
once-per-turn refusal; drawing, refusing and giving up after a blank form all
set the turn's `doneThisTurn` flag, because a cancel means "not now", not "ask
again".

**The Runs-page button draws the same figure a run's own numbers support.**
[research/prisma.ts](src/core/research/prisma.ts)'s `figureFromCounts` maps a
run's measured `PrismaCounts` onto the 2020 field names — `registers`,
`automation`, exclusion reasons and `sought`/`notRetrieved` stay blank because
nothing in the pipeline measures them, and **Edit numbers** on the drawn
figure is where a reviewer adds what the run alone cannot supply, reopening
the same form prefilled with what is already there and redrawing on the same
id in place.

**A chart redraws to fit; a diagram scrolls — because only one of them has no
geometry to protect.** The artifact panel used to draw every chart at a fixed
640×420 regardless of how wide the panel was, so it spilled past the panel's
own bottom edge at the default width. A diagram's canvas deliberately
scrolls rather than shrinking, because its labels are its entire content —
but a chart's axes, ticks and marks are all recomputed from the data at
whatever size they are asked to fill, so there is nothing lost by asking for
a different size. `ChartView.tsx` measures its own canvas box with a
`ResizeObserver` and feeds that through `chartSizeFor` into `layoutChart`'s
new `size` option every time it changes; below 480px wide, a multi-series
legend moves under the plot instead of taking a third of it in the right
margin (`layoutChart` in [layout.ts](src/core/charts/layout.ts)). Export asks
a different question from what fits the panel, so it is a separate, explicit
choice: standard (the figure's own natural size), a portrait page or a
landscape page — a PRISMA figure is conventionally a full portrait page and a
flowchart a landscape one — remembered per figure kind in
[ExportSize.tsx](src/renderer/components/ExportSize.tsx). A page means the
*text block*, inside 1-inch margins, and which paper it is drawn on follows
the account's own locale rather than a setting nobody would think to look
for ([exportSize.ts](src/core/figures/exportSize.ts)). Both `toChartSvg` and
`toSvg` take an optional physical size and, when given one, write the outer
`width`/`height` in inches while the `viewBox` stays in layout pixels — so
the file inserts into a document at that physical size with no transform of
its own, and omitting it (every existing caller) leaves the output exactly
what it always was, which is what keeps `test/diagramSvg.test.ts`'s
byte-identity test pinned.

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

### Peer review

Somebody sends you a manuscript to review, and MyRA writes the panel's reports. It sits
beside the paper drafter and keeps two of its habits — a pure prompt module, so the preview
renders character for character what is sent, and citations **reported rather than
repaired** — but differs in one way that matters: the prompts here are **editable**
([prompt.ts](src/core/review/prompt.ts)). A reviewer's standards are their own and journals
differ, so the rule against inventing literature is stated in the text where it can be read,
not hidden where it cannot be removed. It is not decoration: a small model under test
produced a References section of empty numbered markers on its first run, and a fabricated
citation in a review reaches an editor under the reviewer's name.

**The manuscript arrives as bytes, never as a path.** The renderer reads the dropped `File`
with `arrayBuffer()` — a web API, so the sandbox is untouched — and `pdfToText` already
extracts from a `Uint8Array`. The alternative, `webUtils.getPathForFile`, hands main an
arbitrary absolute path to open for the sake of a convenience; MyRA never learns where a
confidential manuscript lives ([main/review.ts](src/main/review.ts)).

**One request per reviewer, and one shared block of house rules.** The reviewer's two
prompts are about eighty per cent the same text; what differs is *who* the three reviewers
are, and in particular what the methodologist looks for — a statistician on an experiment,
a PRISMA 2020 checklist on a systematic review. So the shared part is one editable block and
each study design carries its own panel; adding a design later means writing three personas,
not another thousand-word prompt free to drift. Asking each persona separately keeps every
request small, the reason [draft.ts](src/core/documents/draft.ts) writes a section at a
time, and three reviewers who have not read each other is what a journal sends an editor. A
reviewer that returns nothing has its failure filed under its own heading rather than
dropped, and stopping after two of three keeps the two.

**Refuse rather than truncate** ([manuscript.ts](src/core/review/manuscript.ts)). A
manuscript is six to twelve thousand words and a model on an 8 GB card commonly holds eight
thousand tokens, so not fitting is the ordinary case. The fit is measured against the
*largest* reviewer rather than the sum — each carries the same manuscript, so what has to
fit is one of them — and it reserves `REPLY_TOKENS` for the reply, because a review that
stops halfway through the major concerns is still a review that goes to an editor. An
unknown window is not a refusal: a hosted provider reports none, and refusing on "we could
not measure it" would block the models most able to do this.

**The report is kept and the manuscript is not.** A review is a flat `<id>.json` under
`reviewsRoot` ([record.ts](src/core/review/record.ts)), written before the first reviewer
and again after every one — the pipeline's rule, so a crash during the third leaves the
first two — and filed into the active project at the moment it comes into existence, since
a member with no file on disk is pruned by the next read. The manuscript is held in memory
for the length of the run and never written: it is somebody else's unpublished paper, and
`~/Documents` is a directory a file manager and any cloud sync can read. The page says so,
because a record that looks like a document but silently lacks its source is worse than one
that explains itself.

Asking *whether* it fits must not behave like a turn. The window is read off the runtime,
where the conversation's own context meter reads it, and never by resolving the endpoint:
resolving calls `ensureChatModel`, so a page that re-asks whenever the runtime changes —
and a model going away is a runtime change — loaded the model straight back in about a
second after the user unloaded it, everywhere, and the card was never actually freed.

### The long job that is not a chat turn

A review panel and a paper section are minutes of work started from a page the window
unmounts as soon as you look at something else, and both used to keep their own
`AbortController` and stream deltas straight at the renderer. So leaving the tab meant the
deltas arrived at nobody, the finished text landed in an unmounted component, and the guard
stayed held — the next attempt refused by a run whose output had already been thrown away.
[work.ts](src/main/work.ts) is one registry for both, and three things about it are the
point.

**The snapshot is absolute, not a delta.** One channel carrying the whole current state.
`runSubagent` retries up to three times and a died-halfway attempt has already streamed half
a report, so both features carried a `reset` flag — the same fix written twice, either of
which could be forgotten. With a whole-state snapshot, writing a report twice is not
expressible.

**A late subscriber gets everything.** `myra:work-state` behind an `ipcMain.handle` is what
lets a page mounting mid-run draw the reviewer already in progress; `myra:research-active`
had no such question and sat blank until the next stage, which is why it now has
`myra:research-active-state` beside it. The precedent is `myra:meeting-state`, not the
research channel.

**One at a time, across both features, and chat is deliberately outside it.** Two long
generations on one card is the OOM meetings avoids by transcribing serially. A chat turn is
short and somebody is waiting for it. A research run stays on `inFlight` rather than joining
the lease: it happens *inside* a chat turn, and folding it in would make starting a run
refuse while a review was writing.

Main owns the record too. `myra:paper-draft` commits the finished section itself, and
`mergeDrafts` ([paper.ts](src/core/papers/paper.ts)) stops the page's 700 ms autosave racing
back over it with the empty draft it still believes in — an older page copy may not blank a
draft that exists on disk, but a non-empty draft it sends always wins, because that is the
author editing prose by hand.

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

Conversion is **pandoc and only pandoc** ([formats.ts](src/core/documents/formats.ts)): CSL
styles, bibliographies and journal templates are the whole point for this audience, and it
is one static binary where LibreOffice was a gigabyte-scale prerequisite the user installed
themselves. MyRA therefore fetches it on first run, into the user's own data directory
beside the model runtime ([main/tools/pandoc.ts](src/main/tools/pandoc.ts)) — from
`releases/latest`, which is right here and wrong for llama.cpp, whose every build is a
prerelease; checked against the sha256 the API publishes; and never an installer, since a
`.deb`, `.pkg` or `.msi` would want privilege for a binary we only ever run ourselves.
Installing it is not a tool call. Two rules on the conversion itself: **the output path is
always explicit**, because LibreOffice wrote beside the input under the same basename and so
converting `report.docx` destroyed the `report.md` next to it — observed, not theorised —
and **the argv is a fixed template** no caller may add flags to.

### The Zotero library

A different question from `academic_research`: the few hundred papers the user has already
decided matter, with metadata they have already corrected — so it sits at the `library`
rung, below anything that leaves the machine. Two ways in, in this order:

1. **Zotero's local HTTP API** ([zotero.ts](src/core/library/zotero.ts)), port 23119, no
   key. Both loopback addresses are tried — `localhost` is 127.0.0.1 *and* ::1, and MyRA
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
[main/runtime/](src/main/runtime/manager.ts); MyRA owns which model to load and the
guarantee that nothing it starts outlives it — including `--no-broadcast`, since
`lemond` otherwise advertises itself over UDP and a local assistant has no business
announcing itself to the network. [api/server.ts](src/main/api/server.ts) is
the only listening socket: off by default, loopback, refuses to start without a key, and
forwards only the paths in [core/api/routes.ts](src/core/api/routes.ts).

Lemonade downloads its engines per recipe (`llamacpp`, `whispercpp`, `kokoro`,
`sd-cpp`) and **starts them itself**, which is a problem MyRA has to solve from the
outside: measured on the released builds, `whisper-server` v1.8.4 and kokoro's `koko`
b17 need `GLIBC_2.38` while `llama-server` b10375 needs 2.34 — so on Ubuntu 22.04 chat
works and every speech model exits code 1 within a tenth of a second. MyRA already
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

A provider's `local`/`external` label may only make MyRA **more** cautious: an endpoint
that is not on this machine is external whatever the label says
([destinations.ts](src/core/destinations.ts) owns that rule, and the privacy report reads
the same function).

### Thinking, and sampling

Reasoning is separated from the answer as it arrives
([thinking.ts](src/core/llm/thinking.ts)). A server uses either convention: llama.cpp with
`--jinja` extracts it into `reasoning_content` beside `content`, while some templates emit
it inline in `<think>` or `<thinking>` tags — which you get depends on the model file, not
on anything MyRA chose, and knowing only the first spelling printed a whole chain of
reasoning into the answer as prose. Inline text is held back only as far as it could still
be part of a tag, at most eleven characters, because a tag arrives split across frames and
passing `<` through makes the answer flicker. Reasoning is never fed back to the model.

**MyRA does not invent a vocabulary for "think harder."** Four vendors have four shapes —
`reasoning_effort`, an OpenRouter object, a Google budget in tokens, an Anthropic one — and
local models have a fifth, where the switch is a variable inside the model's own chat
template. A single Off/Brief/Deep control would have to claim that OpenAI's "low" and a
1024-token Gemini budget are the same thing, and would put MyRA's words in front of a
parameter the user may need to discuss with a sysadmin. So the control shows the field name
and the values that endpoint actually takes
([reasoningDialect.ts](src/core/llm/reasoningDialect.ts)).

**A switch is offered only where it has been measured, and the two sides are measured
differently.** Locally the evidence is the model's own template: `POST /apply-template`
returns the rendered prompt, so rendering the same messages with and without a switch says
whether the template reads it ([templateProbe.ts](src/core/llm/templateProbe.ts)) —
llama.cpp answers 200 to a request carrying `myra_nonsense_param`, so "it did not error"
is never evidence here. Hosted endpoints cannot be read, only asked, so a hosted control
appears only after the reasoning check in Settings → Providers has sent one probe carrying
the field and had it come back clean ([reasoningProbe.ts](src/core/llm/reasoningProbe.ts),
[main/llm/reasoning.ts](src/main/llm/reasoning.ts)): a strict server rejects a whole request
over one unknown parameter, and a chat that 400s is far worse than a chat that does not show
its workings. A dialect's `preferred` — thinking on without being asked — is set only for a
local template switch, never a hosted one, where an effort nobody chose is billed to
somebody's account. "No control" is four states kept apart on purpose: `none` and `always`
are findings, `unchecked` and `unknown` are the absence of one, and printing the first pair
for the second would be MyRA asserting a fact about a model that it does not have.

Sampling is per model and rides on each request ([sampling.ts](src/core/llm/sampling.ts)),
which is what separates it from `runtime/modelOptions.ts`: those are *load* settings that
Lemonade reads when it starts llama-server, so changing one reloads several gigabytes. Each
field declares whether it is `standard`, because llama.cpp accepts a wide sampler set on its
OpenAI-compatible endpoint and a hosted API returns 400 for `top_k` rather than ignoring it.
An unset field is not sent at all, so the server's own default applies — a different thing
from sending what we guess that default to be.

### Speed, measured honestly

`chat.ts`'s `readStream` times a reply against the clock this app already has running anyway
— request sent, first delta arrived, stream closed — and folds in llama.cpp's own `timings`
object when the server sends one (`prompt_ms`, `predicted_ms`), unasked: this app never sends
`timings_per_token`, because a strict server rejects a whole request over a field it does not
recognise, the same lesson the reasoning probe already learned.
[speed.ts](src/core/llm/speed.ts) turns the two into the number under a reply, and its one
rule is that a rate this app did not measure honestly is never printed: no completion tokens
means no tok/s, not a rate of zero rounded away, and `measured` says whether the split
between prefill and generation came from the server or from time-to-first-token standing in
for it.

One event per model call, not per turn — `AgentEvent`'s `"stats"` in
[loop.ts](src/core/agent/loop.ts) — because a turn that calls a tool closes the bubble it was
writing and opens a new one for what comes after, so a turn-level number would land on the
wrong reply or have to sum times that meant different things. The same figure rides on the
stored assistant message as `meta`, which is how it survives reopening a conversation;
`buildRequest` strips it before anything reaches the wire, because a field the server does not
expect is a reason some of them refuse the whole request.

**And how far along it is, while it runs.** Between Send and the first word there was
nothing on screen, and on a local model that gap is the prompt being read — a minute on a
long conversation, identical to a wedged server. `chat()` now reports progress
([progress.ts](src/core/llm/progress.ts), no imports so the renderer shares it): a
`prompt_progress` frame per batch when the server sends one, then a count of reply frames,
throttled to four a second. `return_progress` is asked for **only on the bundled runtime**
(`EndpointResolution.promptProgress`), measured against llama-server b10375 and through
lemond 11.8.0 — `processed` includes the cache, so the bar measures the uncached share —
and never of anything else, for the `timings_per_token` reason above. The loop emits
`"progress"` before every model call, since after a tool the prompt is read again; main
never stores it for replay. The window's `TurnStatus` always shows a moving clock, and a
bar only when a server reported a figure.

### Files dropped into the chat

An image or a document, dropped straight into the composer — OCR and "chat with this paper"
as an ordinary part of a conversation rather than a separate page. The two kinds are treated
completely differently, and the difference is the whole design.

**A document's text is extracted once and inlined into the message**, over `extractDocument`
in [main/extract.ts](src/main/extract.ts) — moved out of review.ts so the chat composer does
not depend on the peer-review module to read a file. Wrapped in the same `asUntrusted` markers
`read_document` already uses: somebody else's paper, dropped in for one question, is untrusted
the same way a fetched web page is. Refused rather than truncated when it will not fit, with
both numbers, the same call peer review already makes. Nothing of the document is kept — no
file is ever written for one.

**An image cannot be inlined as text**, so its bytes go to
`CONFIG_DIR/attachments/<sessionId>/` ([main/attachments.ts](src/main/attachments.ts)) and the
message keeps only a reference — never inline in the session JSON, for the reason a paper's
own manuscript is never written to disk either: `listSessions()` opens every session file just
to read its title, and a handful of inlined photos would make the conversation rail parse
megabytes on every listing. `ChatMessage.content` is never an array for the same reason,
pushed further: widening it would have meant teaching every reader of a stored conversation —
the title, the export renderer, compaction's token estimate — to handle a shape they would see
once in a very long while, for no reader's benefit but the model's. Instead a reference is
expanded into an OpenAI content-part array only inside `buildRequest`
([chat.ts](src/core/llm/chat.ts), calling `expandImages` in
[attach.ts](src/core/llm/attach.ts)), the one place that builds what actually goes on the
wire, from a synchronous `resolveImage` lookup built by reading every image attachment in the
conversation fresh each turn — a stateless HTTP API resends the whole history every time, so
there is no "already seen this" to rely on, and re-reading a handful of small local files is
cheap enough not to be worth a cache.

A model with no `vision` or `omni` label is warned about, never refused: a `custom`-labelled
model's labels are a guess (see the model catalogue section below), and a hosted provider
reports no labels at all — both are reasons to let the user decide, not reasons to block an
image a model might in fact be able to read.

The renderer downscales an image before it ever reaches main — the only side of this app with
a DOM — to at most 1568px on the long edge, because a phone photo is routinely 12 megapixels
and would cost real context on every turn it stays in the conversation for no benefit a vision
encoder can use.

### The persona, and what is not the user's to replace

`systemPrompt()` lived in main and therefore had no test at all — the prompt that decides how
every conversation behaves was the one thing nothing checked. It is
[core/agent/systemPrompt.ts](src/core/agent/systemPrompt.ts) now, and it is four parts of
which exactly one is anybody's to change. `DEFAULT_PERSONA` says who this is and is replaced
wholesale by `Settings.persona`, or per model by `Settings.systemPrompts[key]`. The tool
discipline, the citation rules and the research-mode closing follow it **unchanged**: a
prompt that could remove them could produce a `[1]` pointing at nothing, which is the app's
one unbreakable promise broken by a text box. Both editors say so.

The persona reaches the request through `resolveLlm`, which returns it as a separate field
that **only the chat turn reads** (`index.ts`'s `runTurn` call). That resolver also serves
the paper drafter, the reviewer, meetings and every research stage, and a user's "be terse,
answer in Danish" silently rewriting a PRISMA checklist is precisely the failure to prevent
— so wiring it in anywhere else is a bug however helpful it looks. It is keyed by the same
expression `samplingFor` uses, and main derives that key
(`myra:model-prompt`/`myra:model-facts`) rather than the window: three per-model records
share it now, and a hosted choice is keyed `provider::model` while a local one is keyed by
the model that actually answers.

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

A download has a life of its own ([main/downloads.ts](src/main/downloads.ts), with the pure
record in [core/downloads/download.ts](src/core/downloads/download.ts)). It was a local
variable in the models page, so changing page threw away the name and the progress while the
bytes kept arriving — indistinguishable, from where the user sits, from it having stopped —
and there was no way to stop one on purpose either. Three facts measured against `lemond`
11.8.0 shape it: a streamed `/pull` never appears in `/api/v1/jobs` or `/api/v1/downloads`,
so the daemon's own pause/resume API cannot drive one; aborting the request cancels it at
the far end, so an `AbortController` *is* the stop button; and restarting resumes from the
partial file, so a pause is an abort that keeps the bytes and a resume is a fresh pull.
Cancel additionally asks the daemon to delete what it fetched — never for a model that was
already installed, because re-downloading one must not take the working copy with it.

### Sizing a model, and the flags that change it

The daemon's `ctx_size` default is `-1`, which resolves to **4,096** whatever the model can
do — measured, on one whose ceiling is 131,072. `autoContext` in
[fit.ts](src/core/runtime/fit.ts) is what replaces it, and the delivery is a
`POST /models/{id}/options {ctx_size}` before `/load`: measured against lemond 11.8.0, the
launch command came out as `llama-server … --ctx-size 8192`, so the patch reaches the
process. Not `pinnedConfig` — that is one number for every model, and nothing proves the
daemon reads it.

**Leave a buffer.** The sizer plans to fill 85% of the machine — graphics memory and system
memory together — on top of the 512 MiB + 6% `fitModel` already reserves. This is not caution
for its own sake: a probe asked for a 1,000,000-token window on a 131,072-ceiling model, the
daemon **did not clamp it** — it passed the number to `--ctx-size` — and the OOM killer took
the process. A window that fits on paper still shares the machine with a compositor, a
browser and an allocator that fragments. Three bounds and the smallest wins: the safe share,
the model's trained length, and `max_context_window` from the daemon's own `/models` (which
carries it per model, so the ceiling needs no network at all).

Graphics memory and system memory count together rather than the card alone, and that is safe
for a reason worth naming rather than assuming: measured against the bundled binary,
`llama-server` already defaults `-ngl`/`--n-gpu-layers` to `auto` and ships `--fit` (default
**on**), which "adjusts unset arguments to fit in device memory." A context that spills past
VRAM is not the crash risk it would look like — llama.cpp's own placement logic, working from
exact per-tensor sizes MyRA does not have, is what decides which layers sit on the card and
which on the processor, and it degrades to CPU offload rather than failing outright. What still
has to hold, whichever pool the budget is drawn from, is the 85% margin above and the hard
ceiling below — those are what actually stopped the OOM, not which memory the number was
counted against.

And three refusals, each load-bearing: a `ctx_size` the user set is never touched (`saved`
says which); a recipe with no `ctx_size` is skipped, which is how whispercpp stays out by the
daemon's own field list rather than a name test; and **a window that will not fit is not
written down** — `autoContext` returns nothing and the daemon's own default stands, because
4,096 is a poor default but a number that stops the model loading is worse.

The shape that makes it arithmetic rather than a rule of thumb comes from the model's
`config.json` on Hugging Face ([modelShape.ts](src/core/runtime/modelShape.ts)), fetched
**when a model is downloaded and never when one is loaded** — a load must not become a
network request — and cached in `modelFacts.json` including negative results, so an offline
machine does not re-ask. A partial shape is never built: every field is needed to compute a
cache, and a half-read config produces a number that looks measured and is not. Without one
the floor is used and flagged `estimated`, the same refusal `ContextHint` already makes on
screen. The same fetch reads `generation_config.json`, whose values are applied **under**
anything the user set, per key — so tuning a temperature does not cost you the published
top-p, and clearing a box goes back to what the authors said rather than to nothing.

Everything else people come to this panel for lives inside one free-text string.
[llamaArgs.ts](src/core/runtime/llamaArgs.ts) puts typed controls over it, because the
daemon will not: `llamacpp_args: "--parallel 1 --myra-nonsense 3"` is accepted with a 200
and only fails later, at load, inside a process nobody is watching. **Every token it does not
own is preserved exactly where it stood** — the daemon's own default is `--parallel 1`, and a
panel that silently dropped what it did not recognise would be data loss wearing a form. On
the registry's "never splice a chosen string into a command line": that rule is about
*model*-chosen strings and these are the user's own, already passed through verbatim, so this
narrows what reaches the command line rather than widening it — and it is enforced anyway,
since a value carrying whitespace or a quote is refused unless its field is free text.

Two of those controls are sliders bounded by the model's own layer count rather than a
made-up ceiling — `--n-gpu-layers` and `--n-cpu-moe`, the second offered only when the
model's `config.json` said it routes between experts at all
([modelShape.ts](src/core/runtime/modelShape.ts) checks `num_local_experts`, `num_experts`
and `n_routed_experts`, since no family's `model_type` reliably says "moe" — Mixtral and DBRX
do not). Left on **Auto** — the flag unset, which is also `-ngl`'s own default — `--fit` is
what re-fits both of them every time the context changes, so "change the context and the
layers refit themselves" is `--fit` doing its job rather than something MyRA recomputes from
numbers it can only estimate. Pinning one by hand is respected exactly as a user-set
`ctx_size` already is, since `--fit` only ever touches what is left unset.

On a CUDA backend, `--flash-attn` defaults to `on` rather than the daemon's own `auto`
([manager.ts](src/main/runtime/manager.ts)'s pre-load pass, folded into the same options
patch that sizes the context — one PATCH rather than two), and only when it has never been
set. Measured against the bundled binary: `--flash-attn` on its own now refuses to start the
model outright, `"expected value for argument"` — it takes `auto`, `on` or `off` — which is
what the toggle-kind control here used to write the moment anyone turned it on. Fixed by
making it an `enum` like every other typed value in this list; an old saved config with the
bare form heals itself the next time anything here is edited, since it is read back as a token
nothing owns and dropped rather than carried forward.

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

IPC channels are all `myra:*` — 183 of them, registered in
[main/index.ts](src/main/index.ts)'s `installIpc` and in the `install*Ipc` modules it
calls (meetings, dictation, audio, images, papers, projects, project memory, runtime, api,
review, tasks), and exposed one-by-one in the preload. Adding a capability means touching all
three layers plus `src/renderer/types.ts`, and at that scale a channel wired in only three of
the four is a `window.myra` call that is `undefined` at runtime.

Directories MyRA creates are `0700` and files `0600` (`makePrivateDir` / `makeOwnDir` in
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
