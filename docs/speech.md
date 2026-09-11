---
layout: default
title: Speech & dictation
nav_order: 12
---

# Speech & dictation

Speech in MyRA is **two models, not an endpoint** — one that hears you, one
that speaks — both chosen from a list under **Settings → Audio**.

![Settings, on the Audio pane](assets/screenshots/settings-audio.png)

## Transcription

The list holds what the bundled runtime can run (Whisper and Moonshine) plus
anything a provider you've added offers. This one model is used for both
**dictation** — typing by voice, anywhere there's a text field — and
**meeting transcription**.

## Voice

The second model is what reads answers aloud in **speech-to-speech mode**,
the wave button beside the microphone: it listens, sends when you pause,
answers out loud, and listens again until you switch it off. Talking over
an answer interrupts it. Leave the voice model unset and MyRA stays silent —
speech-to-speech mode just isn't available until you pick one.

## What leaves this machine

Speech is the same local/hosted choice made twice, once per model. A
transcription or voice model from the bundled runtime stays on this
machine. One from a provider you've added means your recordings, or the
text MyRA reads out loud, are sent to that provider — the picker always
says which kind of model you're choosing, and names the model on screen
while it's in use.
