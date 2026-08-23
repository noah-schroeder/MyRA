#!/usr/bin/env bash
# Copy the portable half of the v1 tree into a fresh v2 tree.
# Usage: scripts/port.sh /path/to/karen
#
# Copies only. Nothing is deleted, moved, or modified in this repo.
# See PORT.md for the reasoning behind every line.
set -euo pipefail

DEST="${1:-}"
[ -n "$DEST" ] || { echo "usage: $0 <destination>" >&2; exit 2; }
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ "$(cd "$DEST" 2>/dev/null && pwd || echo x)" != "$SRC" ] || { echo "destination must differ from source" >&2; exit 2; }
if [ -e "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null)" ]; then
  echo "refusing: $DEST exists and is not empty" >&2; exit 2
fi

CORE="$DEST/src/core"
mkdir -p "$CORE"/{meetings,research,documents,llm,agent} \
         "$DEST/src"/{main,preload,renderer} "$DEST/test" \
         "$DEST/reference" "$DEST/vendor"

say() { printf '  %s\n' "$*"; }
copy() { # copy <dest-dir> <files...>
  local d="$1"; shift
  for f in "$@"; do
    [ -e "$SRC/$f" ] || { echo "MISSING: $f" >&2; return 1; }
    cp -R "$SRC/$f" "$d/"
  done
}

echo "==> meetings (verbatim)"
copy "$CORE/meetings" \
  apps/desktop/src/main/transcript.ts \
  apps/desktop/src/main/meetingPrompts.ts \
  apps/desktop/src/main/notes.ts \
  apps/desktop/src/main/meetingRun.ts \
  apps/desktop/src/main/meter.ts \
  apps/desktop/src/main/meeting.ts
say "meeting.ts needs its pw-record dependency cut (PLAN.md §3)"

echo "==> research (verbatim + seams)"
copy "$CORE/research" \
  vm/extensions/research/arxiv.ts \
  vm/extensions/research/openalex.ts \
  vm/extensions/research/semanticscholar.ts \
  vm/extensions/research/hydrate.ts \
  vm/extensions/research/html.ts \
  vm/extensions/research/fetch.ts \
  vm/extensions/research/pdf.ts \
  vm/extensions/research/sources.ts \
  vm/extensions/research/registry.ts \
  vm/extensions/research/rubrics.ts \
  vm/extensions/research/roles.ts \
  vm/extensions/research/embed.ts \
  vm/extensions/research/run.ts \
  vm/extensions/research/extract.ts \
  vm/extensions/research/plan.ts \
  vm/extensions/research/scope.ts \
  vm/extensions/research/screen.ts \
  vm/extensions/research/verify.ts \
  vm/extensions/research/review.ts \
  vm/extensions/research/synthesize.ts \
  vm/extensions/research/pipeline.ts \
  vm/extensions/research/config.ts
say "pipeline.ts + config.ts need SearXNG cut (PLAN.md §5)"
say "the 7 stage files need no edits once runSubagent is swapped (PLAN.md §1)"

echo "==> documents"
copy "$CORE/documents" vm/extensions/docs/formats.ts vm/extensions/docs/office.ts
say "office.ts retargets LibreOffice -> pandoc; keep the fixed-argv rule"

echo "==> llm (seam to replace)"
cp "$SRC/vm/extensions/research/subagent.ts" "$CORE/llm/subagent.v1-reference.ts"
say "replace with an HTTP client; keep the exported signatures identical"

echo "==> policy"
copy "$CORE" packages/protocol/src/policy.ts packages/protocol/src/risk.ts
say "risk.ts shrinks — there is no bash to classify"

echo "==> main"
copy "$DEST/src/main" \
  apps/desktop/src/main/stt.ts \
  apps/desktop/src/main/config.ts \
  apps/desktop/src/main/secrets.ts \
  apps/desktop/src/main/paths.ts
say "config.ts: drop hostAddress + bridge fields; stt.ts: drop appFetch"

echo "==> renderer + preload"
cp -R "$SRC/apps/desktop/src/renderer/." "$DEST/src/renderer/"
cp "$SRC/apps/desktop/src/preload/index.ts" "$DEST/src/preload/"
cp "$SRC/apps/desktop/src/shared/safeUrl.ts" "$DEST/src/"
say "App.tsx, types.ts, SettingsModal.tsx: strip bridge/VM status"

echo "==> tests"
for t in transcript notes meeting meetingRun meter citations markdown-safety; do
  copy "$DEST/test" "apps/desktop/test/$t.test.ts"
done
for t in docs hydrate pdf plan registry research run semanticscholar sources stages synthesis; do
  copy "$DEST/test" "vm/extensions/test/$t.test.ts"
done
copy "$DEST/test" packages/protocol/test/policy.test.ts packages/protocol/test/risk.test.ts
cp "$SRC/vm/extensions/test/harness.ts" "$DEST/test/"

echo "==> reference (not wired up)"
copy "$DEST/reference" \
  apps/desktop/electron-builder.yml \
  apps/desktop/build/after-install.sh \
  scripts/build-deb.sh \
  apps/desktop/src/main/dictation.ts \
  apps/desktop/src/main/audio.ts \
  vm/extensions/docs/index.ts \
  vm/extensions/research/index.ts \
  TODO.md README.md

echo "==> plan"
cp "$SRC/PLAN.md" "$SRC/PORT.md" "$DEST/"
cp "$SRC/tsconfig.base.json" "$DEST/tsconfig.json"

echo
echo "Copied $(find "$DEST" -type f | wc -l) files into $DEST"
echo "Next: read PLAN.md, then Phase 0."
