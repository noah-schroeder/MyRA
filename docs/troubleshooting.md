---
layout: default
title: Troubleshooting
nav_order: 15
---

# Troubleshooting

## "Windows protected your PC" / "Apple could not verify this app"

Expected — MyRA's builds are unsigned on purpose. See
[Installing MyRA](installing.html#why-unsigned) for the one-time step each
OS asks for, and why.

## "pdftotext is not installed"

MyRA reads PDFs — research full texts, a manuscript dropped on the peer
review page — through poppler's `pdftotext`, not a bundled library.

- The **.deb** declares this as a dependency, so `apt install` pulls it in
  automatically. If you installed some other way, or see this on Linux
  anyway: `sudo apt install poppler-utils`.
- The **AppImage** can't declare package dependencies, so it falls back to
  whatever's already on your `PATH` — install poppler-utils yourself.
- **macOS**: `brew install poppler`.
- **Windows**: grab a build from the
  [poppler-windows releases](https://github.com/oschwartz10612/poppler-windows/releases)
  and put it on `PATH`.
- **Running from source** needs this too — see
  [CONTRIBUTING.md](https://github.com/noah-schroeder/myra/blob/main/CONTRIBUTING.md).

## "No engine is installed" / a model won't load

A model needs an engine to run it. Go to **Settings → Runtime** and install
one — downloading a model on its own, from the Models page, doesn't give
you anything that answers. See
[Providers & models](providers-and-models.html) for how MyRA sizes a model
once an engine's in place.

If a specific model refuses to load, it's most often a context size that
doesn't fit your hardware — MyRA tries to compute a safe one automatically,
but a context you've pinned by hand is never overridden, including a stale
one from before you changed GPUs.

## Meeting recording has no audio, or asks for a window to share

Meetings need two permissions: microphone access, and a window/screen share
for the system's own output (used only for audio — MyRA discards the video
immediately). If your OS denied either permission the first time, it won't
ask again automatically; check your system's privacy settings for the app.

## The local API won't start

**Settings → API** refuses to serve without a key. Create one first (there's
a link right on the page), then **Start serving**. It listens on loopback
only unless you explicitly turn on **Also serve on the local network**.

## Still stuck

Open an issue on [GitHub](https://github.com/noah-schroeder/myra/issues)
with your OS, MyRA's version, and what you saw.
