#!/usr/bin/env bash
#
# Build the Karen .deb for the host machine.
#
# The app is only half of Karen: the agent, its extensions and SearXNG run in
# the VM and are installed there by install-vm.sh. This builds the desktop half,
# which is what you copy across and install.
set -euo pipefail

info() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;31m!! \033[0m %s\n' "$*"; }

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# Everything the app imports at runtime has to be built first: the protocol
# package resolves to dist/, and karen-ctl ships as its compiled output.
info "Building the shared protocol package"
npm run build --workspace packages/protocol

info "Building karen-ctl"
npm run build --workspace apps/ctl

info "Checking types"
npm run typecheck

info "Running the tests"
npm test

info "Building the app"
npm run build --workspace apps/desktop

info "Packaging the .deb"
# The config is discovered from the project directory; passing --config as well
# resolves it relative to that same directory and doubles the path.
npx electron-builder --linux deb --projectDir apps/desktop

DEB="$(find "$REPO_DIR/dist" -maxdepth 1 -name '*.deb' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
if [ -z "$DEB" ]; then
  warn "electron-builder finished but produced no .deb"
  exit 1
fi

info "Built $DEB ($(du -h "$DEB" | cut -f1))"
cat <<NOTE

Install it on the host with:

    sudo apt install "$DEB"

It installs the app to /opt/Karen and karen-ctl to /usr/bin, which is what the
dictation hotkey runs. The VM side is separate -- run scripts/install-vm.sh
inside the VM if you have not already.
NOTE
