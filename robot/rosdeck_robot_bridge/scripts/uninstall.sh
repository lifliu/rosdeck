#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this uninstaller with sudo/root." >&2
  exit 1
fi

systemctl disable --now rosdeck-robot-bridge.service 2>/dev/null || true
if [[ -f /userdata/init.sh ]]; then
  sed -i '/# ROSDECK ROBOT BRIDGE/d;/bootstrap-rosdeck-service/d' /userdata/init.sh
fi
if [[ -f /run/systemd/system/rosdeck-robot-bridge.service ]]; then
  mv /run/systemd/system/rosdeck-robot-bridge.service \
    /run/systemd/system/rosdeck-robot-bridge.service.disabled
fi
if [[ -f /etc/systemd/system/rosdeck-robot-bridge.service ]]; then
  mv /etc/systemd/system/rosdeck-robot-bridge.service \
    /etc/systemd/system/rosdeck-robot-bridge.service.disabled
fi
systemctl daemon-reload

echo "Service disabled. /userdata/rosdeck was retained for recovery."
