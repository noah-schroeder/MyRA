---
layout: default
title: Documents
nav_order: 10
---

# Documents

MyRA drafts in Markdown and converts to Word, OpenDocument, HTML, or PDF —
all jailed to a folder you choose.

## Drafting

A document is drafted outline first, then approved, then one section at a
time — and that order is enforced by MyRA, not left to the model's
discretion. A model asked to "plan first" is free to ignore that and write
the whole thing in one pass, which is the failure this design avoids.
Drafting section by section keeps each request small (which is where the
quality gain comes from on a local model), keeps context bounded no matter
how long the document gets, and means a run that fails partway through
still leaves everything written up to that point saved on disk.

## Converting

Conversion goes through **pandoc, and only pandoc** — which is what gives
you CSL citation styles, bibliographies, and journal templates. MyRA fetches
it on first run into its own data directory; it's one static binary, checked
against a published checksum, never an installer asking for privilege.

Pandoc isn't required to run MyRA at all — without it, documents are simply
written as Markdown, and everything else keeps working. PDF output goes
through HTML and the app's own browser engine, so there's no separate LaTeX
toolchain to install.

The output path is always explicit on a conversion — MyRA never writes
beside the input under a guessed name.

## Where files go

Set the documents folder in **Settings → Folders**. Every path MyRA writes
to is resolved and checked on every call, so a symlink pointing outside that
folder doesn't let a write escape it.
