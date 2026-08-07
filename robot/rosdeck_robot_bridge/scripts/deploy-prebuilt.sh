#!/usr/bin/env bash
set -euo pipefail

BUNDLE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_PREFIX="/userdata/rosdeck"
ROS_SETUP=""
ENABLE_SERVICE=1

usage() {
  echo "Usage: sudo ./deploy.sh [--ros-setup PATH] [--prefix PATH] [--no-start]"
  echo "The VBot default environment is /app/script/env.sh."
}

while (($#)); do
  case "$1" in
    --ros-setup) ROS_SETUP="${2:?missing ROS setup path}"; shift 2 ;;
    --prefix) INSTALL_PREFIX="${2:?missing install prefix}"; shift 2 ;;
    --no-start) ENABLE_SERVICE=0; shift ;;
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

if [[ "$(uname -m)" != "${BUNDLE_ARCH}" ]]; then
  echo "Architecture mismatch: bundle=${BUNDLE_ARCH}, robot=$(uname -m)." >&2
  exit 1
fi
if [[ -z "${ROS_SETUP}" ]]; then
  for candidate in "/app/script/env.sh" \
                   "/app/opt/ros/${BUNDLE_ROS_DISTRO}/setup.bash" \
                   "/opt/ros/${BUNDLE_ROS_DISTRO}/setup.bash"; do
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

install_init_hook() {
  local init_script="/userdata/init.sh"
  local marker="# ROSDECK ROBOT BRIDGE"
  local invocation="${INSTALL_PREFIX}/bin/bootstrap-rosdeck-service >>${INSTALL_PREFIX}/log/bootstrap.log 2>&1 &"

  if [[ -f "${init_script}" ]] && grep -Fq "${marker}" "${init_script}"; then
    return
  fi

  install -d /userdata "${INSTALL_PREFIX}/log"
  if [[ ! -f "${init_script}" ]]; then
    printf '%s\n' '#!/usr/bin/env bash' '' "${marker}" "${invocation}" \
      > "${init_script}"
  elif grep -Eq '^[[:space:]]*exit[[:space:]]+0[[:space:]]*$' "${init_script}"; then
    cp -a "${init_script}" "${init_script}.before-rosdeck"
    local temp_script
    temp_script="$(mktemp /userdata/init.sh.XXXXXX)"
    awk -v marker="${marker}" -v invocation="${invocation}" '
      !inserted && $0 ~ /^[[:space:]]*exit[[:space:]]+0[[:space:]]*$/ {
        print marker
        print invocation
        inserted = 1
      }
      { print }
    ' "${init_script}" > "${temp_script}"
    install -m 0755 "${temp_script}" "${init_script}"
    rm -f -- "${temp_script}"
  else
    printf '%s\n' '' "${marker}" "${invocation}" >> "${init_script}"
  fi
  chmod 0755 "${init_script}"
}

set +u
source "${ROS_SETUP}"
if [[ -f "${BUNDLE_DIR}/runtime/local_setup.bash" ]]; then
  source "${BUNDLE_DIR}/runtime/local_setup.bash"
fi
set -u
if [[ "${ROS_DISTRO:-}" != "${BUNDLE_ROS_DISTRO}" ]]; then
  echo "ROS mismatch: bundle=${BUNDLE_ROS_DISTRO}, robot=${ROS_DISTRO:-unknown}." >&2
  exit 1
fi
if [[ "${BUNDLE_PROFILE}" == "vbot" ]]; then
  ros2 pkg prefix function_msgs >/dev/null 2>&1 || {
    echo "Robot runtime is missing function_msgs." >&2
    exit 1
  }
  ros2 pkg prefix software_msgs >/dev/null 2>&1 || {
    echo "Robot runtime is missing software_msgs." >&2
    exit 1
  }
fi
if LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}" ldd "${BUNDLE_DIR}/bin/rosdeck_robot_bridge_node" | grep -q 'not found'; then
  echo "The robot is missing shared libraries required by this bundle:" >&2
  ldd "${BUNDLE_DIR}/bin/rosdeck_robot_bridge_node" >&2
  exit 1
fi

NODE_NAME="rosdeck_robot_bridge"
if [[ "${BUNDLE_PROFILE}" == "zsibot" ]]; then
  NODE_NAME="rosdeck_robot_bridge_zsibot"
fi

install -d "${INSTALL_PREFIX}/bin" "${INSTALL_PREFIX}/runtime" \
  "${INSTALL_PREFIX}/config" "${INSTALL_PREFIX}/systemd"
install -m 0755 "${BUNDLE_DIR}/bin/rosdeck_robot_bridge_node" \
  "${INSTALL_PREFIX}/bin/rosdeck_robot_bridge_node"
if [[ -f "${BUNDLE_DIR}/runtime/local_setup.bash" ]]; then
  cp -a "${BUNDLE_DIR}/runtime/." "${INSTALL_PREFIX}/runtime/"
fi
if [[ -f "${INSTALL_PREFIX}/config/bridge.yaml" ]]; then
  cp -a "${INSTALL_PREFIX}/config/bridge.yaml" \
    "${INSTALL_PREFIX}/config/bridge.yaml.previous"
fi
install -m 0644 "${BUNDLE_DIR}/config/bridge.yaml" \
  "${INSTALL_PREFIX}/config/bridge.yaml"
if [[ ! -f "${INSTALL_PREFIX}/config/bridge.env" ]]; then
  if [[ "${BUNDLE_PROFILE}" == "vbot" ]]; then
    echo "RMW_IMPLEMENTATION=${RMW_IMPLEMENTATION:-rmw_zenoh_cpp}" \
      > "${INSTALL_PREFIX}/config/bridge.env"
    chmod 0644 "${INSTALL_PREFIX}/config/bridge.env"
  else
    install -m 0644 /dev/null "${INSTALL_PREFIX}/config/bridge.env"
  fi
fi

sed \
  -e "s#@ROS_SETUP@#${ROS_SETUP}#g" \
  -e "s#@INSTALL_PREFIX@#${INSTALL_PREFIX}#g" \
  -e "s#@NODE_NAME@#${NODE_NAME}#g" \
  "${BUNDLE_DIR}/templates/run-bridge.in" > "${INSTALL_PREFIX}/bin/run-rosdeck-robot-bridge"
chmod 0755 "${INSTALL_PREFIX}/bin/run-rosdeck-robot-bridge"
sed "s#@INSTALL_PREFIX@#${INSTALL_PREFIX}#g" \
  "${BUNDLE_DIR}/templates/bootstrap-service.in" \
  > "${INSTALL_PREFIX}/bin/bootstrap-rosdeck-service"
chmod 0755 "${INSTALL_PREFIX}/bin/bootstrap-rosdeck-service"
sed "s#@INSTALL_PREFIX@#${INSTALL_PREFIX}#g" \
  "${BUNDLE_DIR}/templates/rosdeck-robot-bridge.service.in" \
  > "${INSTALL_PREFIX}/systemd/rosdeck-robot-bridge.service"
install_init_hook
install -d /run/systemd/system /etc/systemd/system
install -m 0644 "${INSTALL_PREFIX}/systemd/rosdeck-robot-bridge.service" \
  /run/systemd/system/rosdeck-robot-bridge.service
install -m 0644 "${INSTALL_PREFIX}/systemd/rosdeck-robot-bridge.service" \
  /etc/systemd/system/rosdeck-robot-bridge.service

systemctl daemon-reload
if [[ "${ENABLE_SERVICE}" -eq 0 ]]; then
  echo "Installed without starting it in this boot. Run: ${INSTALL_PREFIX}/bin/bootstrap-rosdeck-service"
  exit 0
fi
systemctl restart rosdeck-robot-bridge.service
sleep 2
if ! systemctl is-active --quiet rosdeck-robot-bridge.service; then
  echo "Bridge failed to stay active. Recent logs:" >&2
  journalctl -u rosdeck-robot-bridge.service -n 80 --no-pager >&2 || true
  exit 1
fi

systemctl --no-pager --full status rosdeck-robot-bridge.service || true
echo "Offline deployment successful: profile=${BUNDLE_PROFILE}, node=/${NODE_NAME}"
echo "Boot autostart: registered in /userdata/init.sh"
echo "Logs: journalctl -u rosdeck-robot-bridge -f"
