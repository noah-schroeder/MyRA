#!/bin/sh
set -e

# karen-ctl is what the dictation hotkey actually runs: GNOME spawns it on every
# keypress and it writes one line to the app's control socket. It has to be on
# PATH under exactly the name the app writes into the keybinding.
#
# It runs on the packaged Electron rather than requiring a system Node, because
# a system Node is not a reasonable thing to depend on for a desktop app.
cat > /usr/bin/karen-ctl <<'WRAPPER'
#!/bin/sh
export ELECTRON_RUN_AS_NODE=1
exec /opt/Karen/karen /opt/Karen/resources/karen-ctl.js "$@"
WRAPPER
chmod 0755 /usr/bin/karen-ctl

# The chrome-sandbox helper needs to be setuid root unless the kernel allows
# unprivileged user namespaces. Without this the app refuses to start with a
# message about the sandbox, which reads as a crash.
if [ -f /opt/Karen/chrome-sandbox ]; then
  chown root:root /opt/Karen/chrome-sandbox || true
  chmod 4755 /opt/Karen/chrome-sandbox || true
fi

update-desktop-database -q /usr/share/applications 2>/dev/null || true
