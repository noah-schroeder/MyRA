#!/usr/bin/env bash
# Provision the agent VM for Karen.
#
# Run this INSIDE the VM. It installs pi, lays out the workspace, and installs a
# user systemd unit for karen-bridge. It does not handle the pairing token --
# copy that from Karen's Settings -> Pairing tab, which is a deliberate manual
# step so the secret is never written anywhere it needn't be.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="$HOME/.config/karen"
WORKSPACE="${KAREN_WORKSPACE:-$HOME/Documents/karen}"

info() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;31m!! \033[0m %s\n' "$*"; }

info "Installing pi (dependency install scripts are disabled)"
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version

info "Creating directories"
mkdir -p "$CONFIG_DIR" "$WORKSPACE" "$HOME/.pi/agent/extensions" "$HOME/.pi/sessions"
chmod 700 "$CONFIG_DIR"

if [[ ! -f "$CONFIG_DIR/token" ]]; then
  warn "No pairing token yet."
  warn "In Karen on the host: Settings -> Pairing -> Reveal token, then run the"
  warn "command shown there. Re-run this script afterwards to finish."
else
  chmod 600 "$CONFIG_DIR/token"
  info "Pairing token present"
fi

# pi auto-discovers extensions from ~/.pi/agent/extensions. Symlinking rather
# than copying means edits in the repo take effect on the next pi start.
# Documents are converted by LibreOffice, which is already installed. pandoc is
# NOT required: LibreOffice 26.2 imports Markdown natively -- headings become
# headings and **bold** becomes a real bold run. Install it only if you want its
# extra formats.
if ! command -v libreoffice >/dev/null 2>&1; then
  warn "libreoffice is not installed; document conversion will not work"
fi

info "Linking Karen's extensions into pi"
for ext in research host guard docs; do
  ln -sfn "$REPO_DIR/vm/extensions/$ext" "$HOME/.pi/agent/extensions/karen-$ext"
done

# The guard shares the permission matrix with the host app rather than keeping a
# second copy: one table, so the badge the user sees and the decision actually
# taken cannot drift.
#
# It has to be reachable as a BARE specifier. pi resolves an extension's
# relative imports against the symlink path in ~/.pi, not the real path in the
# repo, so "../../../packages/..." escapes the repo entirely. A node_modules
# INSIDE the extension directory resolves correctly through the symlink.
info "Linking @karen/protocol into the guard extension"
mkdir -p "$REPO_DIR/vm/extensions/guard/node_modules/@karen"
ln -sfn "../../../../../packages/protocol" \
  "$REPO_DIR/vm/extensions/guard/node_modules/@karen/protocol"
( cd "$REPO_DIR" && npm run build --workspace @karen/protocol )

if [[ ! -f "$CONFIG_DIR/bridge.json" ]]; then
  info "Writing default bridge.json (host at the QEMU SLIRP gateway)"
  cat > "$CONFIG_DIR/bridge.json" <<JSON
{
  "hostUrl": "ws://10.0.2.2:8765",
  "workspaceRoot": "$WORKSPACE",
  "sessionDir": "$HOME/.pi/sessions"
}
JSON
fi

info "Building the bridge"
cd "$REPO_DIR"
npm install
npm run build --workspace @karen/protocol
npm run build --workspace @karen/bridge

info "Installing the systemd user unit"
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/karen-bridge.service" <<UNIT
[Unit]
Description=Karen bridge (dials the host app, supervises pi)
After=network-online.target

[Service]
Type=simple
ExecStart=$(command -v node) $REPO_DIR/vm/bridge/dist/index.js
Restart=always
RestartSec=3
Environment=KAREN_LOG_LEVEL=info

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
info "Done. Start it with:  systemctl --user enable --now karen-bridge"
info "Follow logs with:     journalctl --user -u karen-bridge -f"

if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -q karen-searxng; then
  info "SearXNG is running"
else
  warn "SearXNG is not running. Web search and deep research need it:"
  warn "    ./scripts/install-searxng.sh"
  warn "Academic research works without it (OpenAlex and arXiv are called directly)."
fi
