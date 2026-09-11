---
layout: default
title: "Privacy: what leaves this machine"
nav_order: 13
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
| Scholarly search (OpenAlex, arXiv) | always reaches these — no key needed | — |
| Scholarly search (PubMed, CORE) | off until you add a key | search terms + your key, once added |
| Semantic Scholar | — | asked only whether a found paper has an open-access PDF |
| Page reading | — | the page sees a request from this machine |
| Model search / download | — | only on Search, opening a result, or Download; typing sends nothing |
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
