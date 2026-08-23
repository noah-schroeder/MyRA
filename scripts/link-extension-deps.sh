#!/usr/bin/env bash
# Dev convenience only.
#
# pi resolves an extension's imports itself at runtime, so the VM does not need
# this. It exists so the extension can be typechecked and tested OUTSIDE pi.
# Re-run it if pi is reinstalled or upgraded.
#
# Builds a node_modules of symlinks rather than linking pi's own node_modules
# wholesale, because the pi package is not inside its own node_modules -- so a
# blanket link resolves every dependency EXCEPT @earendil-works/pi-coding-agent.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT="$HERE/vm/extensions"
PI_ROOT="$(npm root -g)/@earendil-works/pi-coding-agent"
[ -d "$PI_ROOT/node_modules" ] || { echo "pi not found at $PI_ROOT" >&2; exit 1; }

rm -rf "$EXT/node_modules"
mkdir -p "$EXT/node_modules/@earendil-works" "$EXT/node_modules/@types"

# The agent package itself.
ln -sfn "$PI_ROOT" "$EXT/node_modules/@earendil-works/pi-coding-agent"

# Everything it bundles that extensions are allowed to import.
for pkg in pi-ai pi-tui pi-agent-core pi-protocol; do
  [ -d "$PI_ROOT/node_modules/@earendil-works/$pkg" ] &&
    ln -sfn "$PI_ROOT/node_modules/@earendil-works/$pkg" "$EXT/node_modules/@earendil-works/$pkg"
done

[ -d "$PI_ROOT/node_modules/typebox" ] &&
  ln -sfn "$PI_ROOT/node_modules/typebox" "$EXT/node_modules/typebox"

# Node's own types come from this repo, not from pi.
[ -d "$HERE/node_modules/@types/node" ] &&
  ln -sfn "$HERE/node_modules/@types/node" "$EXT/node_modules/@types/node"

# The guard extension imports the shared permission matrix as a bare specifier.
# It needs its own node_modules, INSIDE the extension directory: pi resolves an
# extension's imports against its symlinked path in ~/.pi, so anything relative
# to the repo root is unreachable at runtime.
mkdir -p "$EXT/guard/node_modules/@karen"
ln -sfn "../../../../../packages/protocol" "$EXT/guard/node_modules/@karen/protocol"

echo "linked $EXT/node_modules -> pi $(cd "$PI_ROOT" && node -p "require('./package.json').version")"
