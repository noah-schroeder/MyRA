#!/bin/sh
set -e
rm -f /usr/bin/karen-ctl
update-desktop-database -q /usr/share/applications 2>/dev/null || true
