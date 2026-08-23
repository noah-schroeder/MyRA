# Karen — roadmap

Status as of 2026-08-20. Phase numbers match the plan.

## Done

- **Phase 0 — foundation.** Monorepo, LF-only JSONL framing, bridge ↔ pi ↔ app
  pipe, secret vault (`safeStorage` → gnome-libsecret), egress filter, GUI model
  configuration with live `set_model` switching.
- **Phase 1 — chat.** Streaming, tool cards, session sidebar with per-chat and
  bulk deletion (cascading to research runs), blocking `extension_ui_request`
  dialogs, model/mode controls, status bar.
- **Phase 5 — research.** SearXNG running loopback-only in Docker.
  `web_search`, `fetch_page` (HTML **and PDF**), `deep_research`,
  `academic_research`, `check_citations`. The deep pipeline runs all ten stages
  — scope → plan → discover → screen → retrieve → extract → synthesize → verify
  → review → revise — with resume, pause and per-stage streaming. OpenAlex
  hydration is gated to scholarly categories; full-text rescue goes OpenAlex →
  Semantic Scholar → open sibling record.
- **Phase 3 (partial) — host tools.** `vm/extensions/host/` exposes the broker's
  implemented verbs to the agent: `notify`, `vault_read`, `vault_write`,
  `tasks_list`, `propose_task`, `clipboard_read`, `clipboard_write`. Verified end
  to end against the real socket, bridge and broker — the allowlist rejects
  unknown verbs and the audit log records every attempt. The review queue UI is
  built, so a proposal can actually become a task.
- **Phase 3 — complete.** Calendar and contacts read from Evolution Data Server
  over D-Bus (`apps/desktop/src/main/eds.ts`, via `busctl --json`), and
  `propose_event` joins `propose_task` in the review queue. Ten agent tools now
  reach the host. Verified against a live EDS: sources enumerated, events and
  contacts created, read back, and removed.
- **Permission enforcement for pi's own tools.** `vm/extensions/guard/` hooks
  pi's `tool_call` event and applies the same matrix the GUI shows, so Guarded
  now prompts on `rm -rf` and YOLO still cannot run an unrecoverable command.
  The mode reaches the VM over a new `set_policy` ctl op — pushed on every
  change, not just read at handshake — and the guard re-reads it per call.
  Fails toward asking: unreadable policy is Manual, unknown tools are dangerous,
  and a call is blocked when the user cannot be asked.
- **Phase 2 — dictation.** A GNOME custom keybinding runs `karen-ctl
  dictate-toggle`, which reaches the app over a unix control socket; `pw-record`
  captures on the host and the WAV is POSTed to the transcription endpoint, with
  the text appended to the composer. Verified end to end with real microphone
  audio. Electron's `globalShortcut` is not used, and cannot be: it does not
  work on Wayland.
- **Phase 4 — meeting mode.** Record, then transcribe once at the end. Chunked
  live transcription was dropped deliberately: on an 8 GB card the transcription
  model and the model that writes the notes cannot both be resident, so the only
  shape that fits is sequential — record, transcribe, unload, write notes. There
  is no need for a live transcript during the meeting.
  - **Capture is built** (`apps/desktop/src/main/meeting.ts`): N tracks to a
    meeting directory, a manifest written before anything is transcribed, and
    device verification up front — `pw-record --target` pointed at a node that
    does not exist silently records the *default* device instead.
  - **Transcript assembly is built** (`transcript.ts`): tracks interleaved by
    timestamp, acoustic bleed removed, speaker runs joined into quotable
    paragraphs, and `verifyQuote` to trace a quoted claim back to the line it
    came from. `stt.ts` now speaks `verbose_json` and passes a vocabulary
    `prompt`.
  - **Notes are built** (`meetingPrompts.ts`, `notes.ts`): two passes —
    grounded extraction, then composition — with every quote checked against
    the transcript in between. Item timestamps come from the matched line, never
    from the model, because a reconstructed quote comes with a reconstructed
    time. Verified end to end against a stub model, including a deliberately
    fabricated action item being caught.
  - **No speaker identification, by decision.** The transcript carries
    timestamps and no labels. Two tracks are still recorded, because a
    microphone alone captures nothing of a remote meeting heard through
    headphones — but they merge into one unlabeled transcript and the user
    never configures or sees them. An owner is named only where the words
    establish it; otherwise Unassigned.
  - **Nothing to fill in.** A title and a date are all the notes pipeline
    needs, and the app has both. Participants and project names remain optional
    prompt inputs that improve name spelling if something ever supplies them —
    a calendar event would, and EDS integration already exists.
  - **Complete.** Report and transcript written to `<Vault>/Karen/Meetings/`
    through the broker's jail, verified action items proposed to the review
    queue, and a panel above the composer for starting and ending a meeting.
    Verified end to end with a real two-track recording: tracks interleaved by
    timestamp, a fabricated action item caught, audio deleted after filing.
  - The LLM endpoint is now on the app's egress allowlist. Notes are written on
    the host deliberately: the VM is the machine that fetches arbitrary web
    pages, so sending meeting transcripts there would move private data toward
    the less trusted side.
  - **Transcription runs on the host, not in the VM.** The VM has a Virtio GPU
    and no CUDA, so a model there would be CPU-only; the card is on the host,
    where the LLM endpoint already lives. Nothing in the code depends on this —
    it is a base URL either way.
- **Documents** (`vm/extensions/docs/`). Markdown in, Word/ODT/PDF/RTF/HTML out,
  and any of those read back as Markdown. **pandoc is not required** — the plan
  assumed it was, but LibreOffice 26.2 imports Markdown natively: headings
  become headings and `**bold**` becomes a real bold run. Two things learned the
  hard way and now enforced in code: conversion writes beside its input under
  the same stem, so converting `report.docx` to Markdown destroys `report.md`
  next to it (every conversion passes `--outdir`); and **snaps get a private
  `/tmp`**, so a conversion given a temp outdir succeeds and writes the file
  somewhere this process cannot see (scratch space lives in the workspace).
  There is still no host-side document verb: the user pulls files across.
- **Presentation.** Markdown rendered as prose (marked's *lexer* → React
  elements, never `innerHTML`); IEEE `[n]` citations linked to their sources
  with hover cards; collapsible reasoning, collapsed by default.

## Next

- **Research settings in the GUI.** SearXNG URL and OpenAlex `mailto` are still
  env vars with working defaults (`KAREN_SEARXNG_URL`, `KAREN_OPENALEX_MAILTO`).
  Everything else now has a page: the language model and transcription each have
  their own self-contained page, and folders are chosen with a native picker.
- **Refine the `web_search` and `deep_research` tool prompts.** They have been
  patched reactively, once per observed failure, and have never been reviewed as
  a whole. Known material, all of it from real sessions:
  - `read` called on http(s) URLs, repeatedly, learning nothing from the ENOENT.
    Currently corrected by instruction only — pi's `read` is a built-in, so the
    call cannot be intercepted nor its error improved. If instruction proves
    insufficient, the enforcement option is dropping `read` from the active set
    while research mode is on, at the cost of "compare this local file to what
    is online".
  - `time_range` volunteered on scholarly categories, which returns zero results
    because SearXNG drops every engine lacking time-range support. Now overridden
    by the GUI and dropped with an explanatory note, but the tool description
    should make it unattractive to guess at in the first place.
  - Citations in `web_search` are instructed, not verified, unlike
    `deep_research` which fails a run on a dangling `[n]`. Decide whether to
    verify web_search citations too, or accept the asymmetry deliberately.
  - Empty results send the model into repeated near-identical queries rather
    than a change of strategy. Worth explicit guidance on what to try next.
  - The guidance has grown to seven bullets on `web_search` alone. Review for
    length, contradiction and ordering — the earlier items were written before
    the citation and time-range rules existed.

## Packaging

`scripts/build-deb.sh` builds the protocol package, karen-ctl and the app,
typechecks, runs the tests, and produces `dist/karen_<version>_amd64.deb`
(96 MB). Install with `sudo apt install ./karen_0.1.0_amd64.deb`.

The package installs to `/opt/Karen` with `dev.karen.app.desktop` and icons at
every size, and `postinst` writes `/usr/bin/karen-ctl` — a wrapper that runs the
ctl script on the packaged Electron with `ELECTRON_RUN_AS_NODE`, so no system
Node is required. Verified by extracting the .deb and running it: the app comes
up, the control socket answers through that exact wrapper, the bridge completes
its handshake and pi spawns.

Two things worth remembering:

- **Do not bundle the main process's dependencies.** Setting
  `externalizeDepsPlugin({ exclude: [...] })` to fold `ws` and `@karen/protocol`
  into the main chunk builds cleanly, starts, creates both listening sockets —
  and then never services them. No exception, no CPU. Left external, everything
  works, and electron-builder resolves the hoisted workspace packages into the
  asar correctly.
- **The packaged process is called `karen`, not `electron`**, and a bridge
  process reports its comm as `MainThread`, not `node`. Cleanup filters keyed on
  the obvious name silently miss both, leaving processes that hold port 8765 and
  the host link. Several confusing failures this session were nothing but that.

## Audit, before packaging

A full pass over wiring, bugs and security before building the .deb. Findings,
all fixed and regression-tested:

- **`find` and `ls` were classified dangerous.** The safe-tool list held `list`
  and `glob`, which pi has never had, and omitted `find` and `ls`, which it
  does. Guarded mode therefore raised a red typed-confirmation prompt on every
  directory listing. The existing test asserted the phantom names, so it agreed
  with the bug. Real built-ins, checked against the installed package: read,
  write, edit, bash, grep, find, ls, tree.
- **The app's own network calls bypassed the egress filter and the activity
  log.** `session.webRequest` only sees Chromium's stack; main-process `fetch`
  is Node's. Verified rather than assumed: with the filter cancelling every
  request, a main-process fetch still returned 200 and was never observed. All
  app fetches now go through `appFetch`, which uses the same allowlist and log,
  and fails closed if no filter is installed.
- **`will-navigate` prefix-matched `http://localhost`**, which also matches
  `http://localhost.evil.com`. Now parsed and compared by hostname.
- **An unreachable IPC handler granted session-wide verb approval.** No caller,
  no dialog behind it. Removed rather than left to be wired up by accident.
- **The meetings folder was captured at startup**, so the Settings field for it
  changed nothing until restart.
- **A meeting in progress was not stopped on quit**, leaving two `pw-record`
  processes writing for up to six hours.
- **`push` could send to a destroyed window** during shutdown.
- **A meeting recorded for an hour before discovering** no endpoint or vault was
  configured. It now says so at the start, without blocking the recording.
- **Two bridges livelocked the app.** The app keeps one host link and closes the
  older as "superseded", so a duplicate bridge displaced the incumbent, which
  reconnected and displaced it back — about a thousand times a second, until the
  app stopped answering its sockets and the log reached 230 MB. A bridge now
  takes a pid lock before opening anything, and stands down if superseded
  anyway. A stale lock from a killed bridge is taken over rather than obeyed.

Checked and found sound: the vault jail (attacked with traversal, absolute
paths, and two symlink escapes — all refused, legitimate writes still work);
floor verbs cannot be blanket-approved, enforced twice in the main process and
not merely hidden in the UI; CSP; `contextIsolation`/`sandbox`/`nodeIntegration`;
no `innerHTML` anywhere in the renderer; secrets and sockets written 0600; no
secret values in any log; the IPC surface has no orphans in either direction;
all 18 tools register and every one is classified.

## Known gaps in what is built

- **Dictation has never been driven by an actual key press.** Every part of the
  chain is verified — the stored command parses to the right argv and runs, and
  running it records and transcribes — but pressing the key is the one step a
  test cannot perform. Bind it in Settings → Dictation and try it.
- **The silence warning is calibrated against digital silence, not a quiet
  room.** This machine's only capture device currently returns pure zeros, so
  the floor below which the meter says "no sound" was set low enough to be safe
  rather than measured against real room noise. On the host, with a real
  microphone, check that a working-but-quiet input never trips the warning.

- **The approval dialog has never been clicked in anger.** Floor verbs
  (`propose_task`, `propose_event`, clipboard) block on a human click, and that
  path has only been exercised to the point of *reaching* the dialog. Approve,
  deny and "always allow" all need a real run.
- **EDS reads whatever calendars the host has**, including remote ones. A stale
  or unreachable source is skipped rather than failing the whole query, which
  means a partial answer can look complete. Worth surfacing which calendars were
  actually reached.

- **API keys do not survive an app restart on this VM.** Its keyring accepts
  secrets and loses them, so Karen refuses to persist them rather than pretend.
  Re-enter in Settings, or set `KAREN_LLM_KEY` in the bridge environment. Real
  hardware with a working login keyring does not have this problem.
- **Nothing has been tested against a real model end to end.** Every stage is
  covered by tests against a mock; the LLM endpoint has been unreachable
  throughout. The first real run is the real test.
- **The guard is defence in depth, not a security boundary.** Shell is not
  reliably parseable and a determined adversary can obfuscate past any pattern
  list. What actually contains a hostile agent is the VM plus the broker's tiny
  allowlist. The guard stops honest accidents and the obvious shapes prompt
  injection takes.
- **web_search citations are instructed, not verified.** Deep research fails a
  run on a dangling `[n]`; web search only asks the model to cite. Unbacked
  markers render as plain text rather than links, so under-citing is visible.
- **No citation-graph traversal.** `referenced_works` is counted, never
  followed; `filter=cites:` is unused. No snowballing.
- **No cross-database dedup** beyond canonical URL, and no preprint ↔ published
  collapsing: arXiv and journal versions of one paper count twice.
- **No retraction or integrity check** (Crossref / Retraction Watch).
- **Unpaywall was measured and rejected**, not overlooked: 124/124 agreement
  with what OpenAlex already returns. Do not re-propose it.
