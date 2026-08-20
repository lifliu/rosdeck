#!/usr/bin/env bash
set -euo pipefail
# First-install / bundle deploy front end. All layout and lifecycle work
# lives in lib/deploy-core.sh (A/B release slots under $PREFIX/releases,
# atomic `current` symlink, health-checked switch with auto-rollback);
# this script only parses arguments and validates the bundle.
#
# Upgrades after the first install go through bin/ota.sh, not this script.

BUNDLE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_PREFIX=""
ROS_SETUP=""
ENABLE_SERVICE=1
ENABLE_FOXGLOVE=-1

usage() {
  echo "Usage: sudo ./deploy.sh [--ros-setup PATH] [--prefix PATH] [--no-start] [--no-foxglove]"
  echo "Defaults: vbot=/userdata/rosdeck + /userdata/startup.sh; zsibot=/opt/rosdeck + systemd."
}

while (($#)); do
  case "$1" in
    --ros-setup) ROS_SETUP="${2:?missing ROS setup path}"; shift 2 ;;
    --prefix) INSTALL_PREFIX="${2:?missing install prefix}"; shift 2 ;;
    --no-start) ENABLE_SERVICE=0; shift ;;
    --no-foxglove) ENABLE_FOXGLOVE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run deployment with sudo/root." >&2
  exit 1
fi
if [[ ! -f "${BUNDLE_DIR}/manifest.env" ]]; then
  echo "Invalid bundle: manifest.env is missing." >&2
  exit 1
fi
source "${BUNDLE_DIR}/manifest.env"
: "${BUNDLE_PROFILE:?missing bundle profile}"
: "${BUNDLE_ARCH:?missing bundle architecture}"
: "${BUNDLE_ROS_DISTRO:?missing bundle ROS distribution}"
: "${BUNDLE_ZSIBOT_MODEL:=}"
if [[ ! "${BUNDLE_PROFILE}" =~ ^(vbot|zsibot)$ ]]; then
  echo "Unsupported bundle profile: ${BUNDLE_PROFILE}" >&2
  exit 2
fi
if [[ "${ENABLE_FOXGLOVE}" -lt 0 ]]; then
  if [[ "${BUNDLE_PROFILE}" == "zsibot" ]]; then
    ENABLE_FOXGLOVE=1
  else
    ENABLE_FOXGLOVE=0
  fi
fi
if [[ "${BUNDLE_PROFILE}" == "zsibot" && ! "${BUNDLE_ZSIBOT_MODEL}" =~ ^(zsl-1|zsl-1w)$ ]]; then
  echo "Invalid Zsibot bundle model: ${BUNDLE_ZSIBOT_MODEL:-missing}" >&2
  exit 2
fi

# Self-check against the embedded release manifest (config hash, source
# pins, staged packages). Bundles built before the manifest existed have
# no tools/ directory and deploy as before.
if [[ -f "${BUNDLE_DIR}/tools/release_artifacts.py" ]] && command -v python3 >/dev/null 2>&1; then
  python3 "${BUNDLE_DIR}/tools/release_artifacts.py" verify-bundle "${BUNDLE_DIR}"
fi

if [[ -z "${INSTALL_PREFIX}" ]]; then
  if [[ "${BUNDLE_PROFILE}" == "vbot" ]]; then
    INSTALL_PREFIX="/userdata/rosdeck"
  else
    INSTALL_PREFIX="/opt/rosdeck"
  fi
fi

if [[ "$(uname -m)" != "${BUNDLE_ARCH}" ]]; then
  echo "Architecture mismatch: bundle=${BUNDLE_ARCH}, robot=$(uname -m)." >&2
  exit 1
fi
if [[ -z "${ROS_SETUP}" ]]; then
  if [[ "${BUNDLE_PROFILE}" == "vbot" ]]; then
    ROS_CANDIDATES=(
      "/app/script/env.sh"
      "/app/opt/ros/${BUNDLE_ROS_DISTRO}/setup.bash"
      "/opt/ros/${BUNDLE_ROS_DISTRO}/setup.bash"
    )
  else
    ROS_CANDIDATES=(
      "/opt/ros/${BUNDLE_ROS_DISTRO}/setup.bash"
      "/app/opt/ros/${BUNDLE_ROS_DISTRO}/setup.bash"
    )
  fi
  for candidate in "${ROS_CANDIDATES[@]}"; do
    if [[ -f "${candidate}" ]]; then
      ROS_SETUP="${candidate}"
      break
    fi
  done
fi
if [[ -z "${ROS_SETUP}" || ! -f "${ROS_SETUP}" ]]; then
  echo "ROS environment script was not found; pass --ros-setup PATH." >&2
  exit 1
fi
command -v systemctl >/dev/null 2>&1 || {
  echo "systemd/systemctl is required for automatic startup." >&2
  exit 1
}

CORE="${BUNDLE_DIR}/lib/deploy-core.sh"
if [[ ! -f "${CORE}" ]]; then
  echo "Invalid bundle: lib/deploy-core.sh is missing." >&2
  echo "Bundles built before the A/B release layout do not support this" >&2
  echo "deployer; rebuild the bundle from current rosdeck." >&2
  exit 1
fi
# shellcheck source=/dev/null
source "${CORE}"

NODE_NAME="rosdeck_robot_bridge"
if [[ "${BUNDLE_PROFILE}" == "zsibot" ]]; then
  NODE_NAME="rosdeck_robot_bridge_zsibot"
fi

rosdeck_install_bundle "${BUNDLE_DIR}" "${INSTALL_PREFIX}" "${ROS_SETUP}" \
  "${BUNDLE_PROFILE}" "${BUNDLE_ARCH}" "${BUNDLE_ROS_DISTRO}" "${NODE_NAME}" \
  "${ENABLE_FOXGLOVE}" 3 "${ENABLE_SERVICE}"

echo "Offline deployment successful: profile=${BUNDLE_PROFILE}, model=${BUNDLE_ZSIBOT_MODEL:-n/a}, node=/${NODE_NAME}"