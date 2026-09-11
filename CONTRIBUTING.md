# Contributing

## Building and testing

Needs **Node 24** and **poppler** (`pdftotext`) — see
[README: Running it from source](README.md#running-it-from-source).

```
npm install
npm run dev         # run it
npm test            # node's test runner
npm run typecheck   # tsc, no emit
```

Run both `npm test` and `npm run typecheck` before opening a pull request —
neither runs automatically on save.

## Before you start on something bigger

For anything more than a small fix, open an issue first to talk through the
approach.

## Conventions

- **Comments explain why**, usually naming the concrete failure that
  motivated the code. A comment restating the line below it is noise.
- **Commit subjects are sentences about behaviour** — "Ask the provider
  whether it sends reasoning, instead of guessing" — not `type(scope):`
  prefixes.
- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and
  `verbatimModuleSyntax` are all on. Write `| undefined` explicitly where a
  field must be clearable.
- **Runtime dependencies are `katex` and `marked`, and nothing else.** Adding
  one to the main process is a supply-chain decision, not a convenience —
  raise it in the PR description.
- **No telemetry, no auto-updater, no remote assets**, spellchecker off. If a
  change makes the app fetch something at runtime, it needs a line in the
  README's [What leaves this machine](README.md#what-leaves-this-machine).

## Security boundary

The tool registry ([registry.ts](src/core/agent/registry.ts)) is the
complete set of things the agent can do — there is no `bash`. Two rules hold
that boundary up and apply to any new tool:

1. Tools build their own argv from a fixed template; no passthrough
   arguments.
2. Every path is resolved and jailed on every call, with `realpath`, after
   normalisation.

See the README's [Architecture](README.md#architecture) section for more.

## Docs site

The [docs site](https://noah-schroeder.github.io/myra/) lives in `docs/` and
builds with GitHub Pages' native Jekyll support — no local Ruby toolchain
needed to edit it, just Markdown files under `docs/`. Screenshots live in
`docs/assets/screenshots/`; keep them free of real user data — MyRA reads
`HOME` (and `MYRA_CONFIG_DIR`) for where it stores everything, so a throwaway
`HOME` gives a clean, empty profile to screenshot from.
