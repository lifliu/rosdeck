#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_PROFILE=""
if [[ -f "${SCRIPT_DIR}/manifest.env" ]]; then
  source "${SCRIPT_DIR}/manifest.env"
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this uninstaller with sudo/root." >&2
  exit 1
fi

systemctl disable --now rosdeck-robot-bridge.service 2>/dev/null || true
systemctl disable --now rosdeck-foxglove-bridge.service 2>/dev/null || true
systemctl disable --now omni-ws-gateway.service 2>/dev/null || true
if [[ "${BUNDLE_PROFILE}" == "vbot" && -f /userdata/startup.sh ]]; then
  sed -i '/# ROSDECK ROBOT BRIDGE/d;/bootstrap-rosdeck-service/d' /userdata/startup.sh
fi
if [[ -f /run/systemd/system/rosdeck-robot-bridge.service ]]; then
  mv /run/systemd/system/rosdeck-robot-bridge.service \
    /run/systemd/system/rosdeck-robot-bridge.service.disabled
fi
if [[ -f /run/systemd/system/rosdeck-foxglove-bridge.service ]]; then
  mv /run/systemd/system/rosdeck-foxglove-bridge.service \
    /run/systemd/system/rosdeck-foxglove-bridge.service.disabled
fi
if [[ -f /run/systemd/system/omni-ws-gateway.service ]]; then
  mv /run/systemd/system/omni-ws-gateway.service \
    /run/systemd/system/omni-ws-gateway.service.disabled
fi
if [[ -f /etc/systemd/system/rosdeck-robot-bridge.service ]]; then
  mv /etc/systemd/system/rosdeck-robot-bridge.service \
    /etc/systemd/system/rosdeck-robot-bridge.service.disabled
fi
if [[ -f /etc/systemd/system/rosdeck-foxglove-bridge.service ]]; then
  mv /etc/systemd/system/rosdeck-foxglove-bridge.service \
    /etc/systemd/system/rosdeck-foxglove-bridge.service.disabled
fi
if [[ -f /etc/systemd/system/omni-ws-gateway.service ]]; then
  mv /etc/systemd/system/omni-ws-gateway.service \
    /etc/systemd/system/omni-ws-gateway.service.disabled
fi
systemctl daemon-reload

if [[ "${BUNDLE_PROFILE}" == "vbot" ]]; then
  echo "Service disabled. /userdata/rosdeck was retained for recovery."
else
  echo "Service disabled. /opt/rosdeck was retained for recovery."
fi
