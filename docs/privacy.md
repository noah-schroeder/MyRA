---
layout: default
title: "Privacy: what leaves this machine"
nav_order: 16
---

# Privacy: what leaves this machine

Stated plainly, because a privacy claim is only honest if its edges are
named.

## Summary

| Feature | Stays local when... | Leaves when... |
|---|---|---|
| Chat / conversation | endpoint is a local runtime | endpoint is a hosted provider |
| Dictation & meeting transcription | transcription model is local | transcription model is a provider's |
| Speech-to-speech voice | voice model is local | voice model is a provider's |
| Image generation | image model is local | image model is a provider's |
| Paper drafter | model drafting the section is local | model is a provider's |
| A research project's notes | endpoint the conversation is using is local | notes ride in every request to a hosted endpoint, same as any system prompt |
| A project's papers (uploads, Zotero PDFs) | endpoint reading them is local | passages/sections go to a hosted endpoint when it asks for them |
| Figures (diagrams, charts, tables, PRISMA) | always — drawn by MyRA's own code | never; a file is written only when you press Export |
| Scholarly search (OpenAlex, arXiv) | always reaches these — no key needed | — |
| Scholarly search (PubMed, CORE) | off until you add a key | search terms + your key, once added |
| Semantic Scholar | — | asked only whether a found paper has an open-access PDF |
| Page reading | — | the page sees a request from this machine |
| Model search / download | — | only on Search, opening a result, or Download; typing sends nothing |
| Hugging Face token | not sent with an ordinary download | sent only for a gated repository, unless you chose "Always send my token" |
| Engine update checks | — | only when you press the button in Settings → Runtime |
| Files, transcripts, meeting audio, history | always | never |

## In full

- **Your prompts and audio go to the endpoints you configured.** Point them
  at localhost and nothing leaves. Point them at a hosted API and that
  traffic goes there. The app cannot change that.
- **Speech is the same choice made twice.** A transcription or voice model
  from the bundled runtime stays here; one from a provider you added means
  your recordings, or the answers MyRA reads out, are sent to that provider.
  The picker says which it is, and the model chosen is named on screen.
- **Images go wherever their model is.** A model from the bundled runtime
  draws on this machine and the prompt stays here; one from a provider you
  added means the prompt is sent to that provider. The picker says which,
  and warns above the hosted ones.
- **Drafting a paper** sends the section you asked for — your writing
  sample, your notes and your instructions — to whichever model the bar
  names, and nothing else. A local model means it stays here. The prompt
  preview shows exactly what would be sent, and showing it sends nothing.
- **Scholarly searches** reach OpenAlex and arXiv, which need no key. PubMed
  and CORE are off until you add your own free key for each in
  **Settings → Database keys**; once added, a search that includes them
  sends your search terms and that key. Semantic Scholar is asked only
  whether a paper already found has an open-access PDF.
- **A research project's notes** ride in every chat request made inside that
  project, to whichever model the bar names — the same rule as any other
  system prompt. Growing them on their own makes one short extra request to
  that same model before each reply. A deep run started in the project also
  gives its scoping step the settled notes.
- **A project's papers** — passages and sections read from papers you
  uploaded or from your Zotero PDFs — go to whichever model the bar names
  when the model asks for them, like any other tool result. Nothing is
  looked up about a paper you add: its title and DOI are read off its own
  first pages.
- **Figures never leave this machine on their own.** A diagram, chart, table,
  or PRISMA figure is drawn by MyRA's own code from data already in the
  conversation; a file is written only when you press Save SVG, Save PNG, or
  Copy figure.
- **Pages you ask it to read** see a request from this machine.
- **Looking for a model** reaches Hugging Face, and only when you press
  something: Search sends what you typed, opening a result asks for that
  repository's details and its model card, and Download fetches the files.
  Typing in the box sends nothing. The registry is named, with its country,
  on every result and on every model's page.
- **Downloading a model** also asks Hugging Face for that model's
  `config.json` and `generation_config.json` — two small text files beside
  the weights — so MyRA can size the context window to your machine rather
  than accept the daemon's 4,096, and can start from the sampler settings
  the model's authors published. Same host as the download itself, only
  when you download, and nothing is sent but the repository name. Loading a
  model afterwards asks nothing: what was learned is kept on this machine.
- **A Hugging Face access token**, when you add one in **Settings → Runtime**,
  is never sent with an ordinary download — MyRA's downloads stay anonymous by
  default. It is sent only for a repository the registry itself reports as
  gated, and only to Hugging Face, to fetch exactly that repository — unless
  you choose "Always send my token", which sends it with every download. A
  token you paste is encrypted into this machine's own keyring, the same as
  every other API key.
- **Checking for engine updates** asks GitHub which builds of llama.cpp,
  whisper.cpp and the rest have been released, and only when you press the
  button in **Settings → Runtime**. MyRA never checks on its own, and
  installing one is a separate press.
- Everything else — files, transcripts, meeting audio, conversation history
  — never crosses the network at all.

## No telemetry, no auto-updater

There is no telemetry, no auto-updater, no crash reporting, and no remote
assets: the content security policy is `default-src 'self'`, and the
spellchecker is disabled because Chromium otherwise fetches dictionaries
from Google.
