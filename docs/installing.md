---
layout: default
title: Installing MyRA
nav_order: 2
---

# Installing MyRA

Download the build for your platform from
[Releases](https://github.com/noah-schroeder/myra/releases/latest).

Every build is **unsigned**, on purpose (see [why](#why-unsigned) below), so
the first launch takes one extra step depending on your OS.

## Linux

The `.deb` installs and runs normally:

```
sudo apt install ./MyRA-*.deb
```

The `.AppImage` needs no package manager or root:

```
chmod +x MyRA-*.AppImage
./MyRA-*.AppImage
```

## Windows

Windows SmartScreen will say *"Windows protected your PC."* Click **More
info**, then **Run anyway**. You'll only see this once.

## macOS

macOS will say *"Apple could not verify this app is free of malware."*

**Try to open the app first**, then go to **System Settings → Privacy &
Security**, scroll down, and click **Open Anyway**, then **Open**.

That order matters: the **Open Anyway** button only appears for about an
hour after a failed launch attempt, so opening Settings first can find
nothing there.

## Why unsigned

Nobody paid Apple or Microsoft to sign these builds.

- On Windows, that costs the SmartScreen warning above.
- On macOS, it costs the Gatekeeper dialog above. A Developer ID would
  remove that dialog and fix nothing else about the app, so it isn't worth
  $99/year on its own.
- Ad-hoc signing (free) was considered and rejected: a known electron-builder
  regression makes an ad-hoc-signed build open the microphone and receive
  silence, with no error — the worst possible failure mode for an app whose
  two headline features are dictation and meeting capture. So these builds
  skip signing entirely rather than sign ad-hoc.

## Next

Continue to [First run](first-run.html) for the one-time setup.
