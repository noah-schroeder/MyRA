# Karen

A private, local-first executive assistant. A desktop GUI on your main machine,
driven by a [pi](https://pi.dev) agent sandboxed in a VM.

## Why it is built this way

pi has no sandbox of its own — its own docs say so, and inside the VM it runs
with the full permissions of its process. That is fine, because **the VM is the
containment**. The desktop app is the single door out of it: a small allowlist of
host verbs, path-jailed, policy-gated, and audited.

Two network zones with opposite policies:

| Zone | Policy |
|---|---|
| Host app | **default-deny** — only your transcription endpoint and the bridge socket |
| VM | **open web** — research must reach arbitrary sites |

You never maintain a list of websites. The host allowlist is derived from your
settings and has two entries; research happens in the VM and never passes through
the host's network layer at all.

## Layout

```
packages/protocol   wire types, LF-only JSONL framing, permission policy, risk classifier
apps/desktop        the Electron app (host)
vm/bridge           karen-bridge: dials the host, supervises pi, owns models.json
scripts/install-vm.sh
```

## Running it

**Host:**
```bash
npm install
npm run build --workspace @karen/protocol
cd apps/desktop && npm run build && npx electron .
```

**VM:** `scripts/install-vm.sh`, then pair it from Settings → Pairing.

### Developing inside a VM

Electron 43 segfaults on **native Wayland** under a virtio GPU. Use XWayland there:

```bash
npm run start:vm --workspace @karen/desktop   # adds --ozone-platform=x11
```

On a real host with a GPU, native Wayland works and no flag is needed.

If you launch from a VS Code terminal, unset `ELECTRON_RUN_AS_NODE=1` first —
VS Code sets it, and it makes Electron behave as plain Node.

## Tests

```bash
npm test --workspaces
```

The suites worth knowing about:

- **JSONL framing** — pi's protocol is LF-delimited and *only* LF-delimited.
  Node's `readline` also splits on U+2028/U+2029, which are legal inside JSON
  strings and appear in real model output; using it silently desyncs the stream.
  There is a test proving our splitter does not.
- **Permission floor** — a test asserts that *no* mode, YOLO included, can
  auto-approve a catastrophic command or anything touching your systems of record.
- **Risk classifier** — `rm -rf /` is catastrophic; `rm -rf build` is merely
  dangerous. Getting that distinction wrong would make YOLO prompt on routine
  cleanup and thereby useless.
