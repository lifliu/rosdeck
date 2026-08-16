#!/usr/bin/env bash
set -euo pipefail

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
  [[ "${BUNDLE_PROFILE}" == "zsibot" ]] && ENABLE_FOXGLOVE=1 || ENABLE_FOXGLOVE=0
fi
if [[ "${BUNDLE_PROFILE}" == "zsibot" && ! "${BUNDLE_ZSIBOT_MODEL}" =~ ^(zsl-1|zsl-1w)$ ]]; then
  echo "Invalid Zsibot bundle model: ${BUNDLE_ZSIBOT_MODEL:-missing}" >&2
  exit 2
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

install_init_hook() {
  local init_script="/userdata/startup.sh"
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
    temp_script="$(mktemp /userdata/startup.sh.XXXXXX)"
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
if [[ "${ENABLE_FOXGLOVE}" -eq 1 ]] && ! ros2 pkg prefix foxglove_bridge >/dev/null 2>&1; then
  echo "foxglove_bridge is required for mobile connections but is not installed." >&2
  echo "Install it first: sudo apt install ros-${BUNDLE_ROS_DISTRO}-foxglove-bridge" >&2
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
RUNTIME_EXECUTABLES=(
  "${BUNDLE_DIR}/runtime/lib/rosdeck_robot_bridge/rosdeck_robot_bridge_node"
  "${BUNDLE_DIR}/runtime/lib/rosdeck_robot_bridge/rosdeck_safety_supervisor_node"
)
for runtime_executable in "${RUNTIME_EXECUTABLES[@]}"; do
  if [[ ! -x "${runtime_executable}" ]]; then
    echo "Invalid bundle: product runtime executable is missing: ${runtime_executable}" >&2
    exit 1
  fi
  if LD_LIBRARY_PATH="${BUNDLE_DIR}/runtime/lib:${LD_LIBRARY_PATH:-}" \
    ldd "${runtime_executable}" | grep -q 'not found'; then
    echo "The robot is missing shared libraries required by this bundle:" >&2
    LD_LIBRARY_PATH="${BUNDLE_DIR}/runtime/lib:${LD_LIBRARY_PATH:-}" \
      ldd "${runtime_executable}" >&2
    exit 1
  fi
done

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
DEFAULT_ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-0}"
DEFAULT_RMW_IMPLEMENTATION="${RMW_IMPLEMENTATION:-rmw_zenoh_cpp}"
if [[ "${BUNDLE_PROFILE}" == "zsibot" ]]; then
  DEFAULT_ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-24}"
  DEFAULT_RMW_IMPLEMENTATION="${RMW_IMPLEMENTATION:-rmw_zenoh_cpp}"
fi
if ! grep -Eq '^[[:space:]]*ROS_DOMAIN_ID=' "${INSTALL_PREFIX}/config/bridge.env"; then
  echo "ROS_DOMAIN_ID=${DEFAULT_ROS_DOMAIN_ID}" >> "${INSTALL_PREFIX}/config/bridge.env"
fi
if ! grep -Eq '^[[:space:]]*ROS_LOCALHOST_ONLY=' "${INSTALL_PREFIX}/config/bridge.env"; then
  echo "ROS_LOCALHOST_ONLY=${ROS_LOCALHOST_ONLY:-0}" >> "${INSTALL_PREFIX}/config/bridge.env"
fi
if ! grep -Eq '^[[:space:]]*RMW_IMPLEMENTATION=' "${INSTALL_PREFIX}/config/bridge.env"; then
  echo "RMW_IMPLEMENTATION=${DEFAULT_RMW_IMPLEMENTATION}" >> "${INSTALL_PREFIX}/config/bridge.env"
fi
chmod 0644 "${INSTALL_PREFIX}/config/bridge.env"
if [[ "${ENABLE_FOXGLOVE}" -eq 1 && ! -f "${INSTALL_PREFIX}/config/foxglove.env" ]]; then
  printf '%s\n' 'FOXGLOVE_ADDRESS=0.0.0.0' 'FOXGLOVE_PORT=8765' \
    > "${INSTALL_PREFIX}/config/foxglove.env"
  chmod 0644 "${INSTALL_PREFIX}/config/foxglove.env"
fi

sed \
  -e "s#@ROS_SETUP@#${ROS_SETUP}#g" \
  -e "s#@INSTALL_PREFIX@#${INSTALL_PREFIX}#g" \
  -e "s#@NODE_NAME@#${NODE_NAME}#g" \
  -e "s#@PROFILE@#${BUNDLE_PROFILE}#g" \
  "${BUNDLE_DIR}/templates/run-bridge.in" > "${INSTALL_PREFIX}/bin/run-rosdeck-robot-bridge"
chmod 0755 "${INSTALL_PREFIX}/bin/run-rosdeck-robot-bridge"
if [[ "${ENABLE_FOXGLOVE}" -eq 1 ]]; then
  sed \
    -e "s#@ROS_SETUP@#${ROS_SETUP}#g" \
    -e "s#@INSTALL_PREFIX@#${INSTALL_PREFIX}#g" \
    "${BUNDLE_DIR}/templates/run-foxglove.in" \
    > "${INSTALL_PREFIX}/bin/run-rosdeck-foxglove-bridge"
  chmod 0755 "${INSTALL_PREFIX}/bin/run-rosdeck-foxglove-bridge"
fi
sed "s#@INSTALL_PREFIX@#${INSTALL_PREFIX}#g" \
  "${BUNDLE_DIR}/templates/bootstrap-service.in" \
  > "${INSTALL_PREFIX}/bin/bootstrap-rosdeck-service"
chmod 0755 "${INSTALL_PREFIX}/bin/bootstrap-rosdeck-service"
sed "s#@INSTALL_PREFIX@#${INSTALL_PREFIX}#g" \
  "${BUNDLE_DIR}/templates/rosdeck-robot-bridge.service.in" \
  > "${INSTALL_PREFIX}/systemd/rosdeck-robot-bridge.service"
if [[ "${ENABLE_FOXGLOVE}" -eq 1 ]]; then
  sed "s#@INSTALL_PREFIX@#${INSTALL_PREFIX}#g" \
    "${BUNDLE_DIR}/templates/rosdeck-foxglove-bridge.service.in" \
    > "${INSTALL_PREFIX}/systemd/rosdeck-foxglove-bridge.service"
fi
if [[ "${BUNDLE_PROFILE}" == "vbot" ]]; then
  install_init_hook
  install -d /run/systemd/system /etc/systemd/system
  install -m 0644 "${INSTALL_PREFIX}/systemd/rosdeck-robot-bridge.service" \
    /run/systemd/system/rosdeck-robot-bridge.service
  install -m 0644 "${INSTALL_PREFIX}/systemd/rosdeck-robot-bridge.service" \
    /etc/systemd/system/rosdeck-robot-bridge.service
else
  install -d /etc/systemd/system
  install -m 0644 "${INSTALL_PREFIX}/systemd/rosdeck-robot-bridge.service" \
    /etc/systemd/system/rosdeck-robot-bridge.service
fi
if [[ "${ENABLE_FOXGLOVE}" -eq 1 ]]; then
  install -m 0644 "${INSTALL_PREFIX}/systemd/rosdeck-foxglove-bridge.service" \
    /etc/systemd/system/rosdeck-foxglove-bridge.service
fi

systemctl daemon-reload
if [[ "${ENABLE_SERVICE}" -eq 0 ]]; then
  echo "Installed without starting it in this boot."
  exit 0
fi
if [[ "${BUNDLE_PROFILE}" == "vbot" ]]; then
  systemctl restart rosdeck-robot-bridge.service
else
  systemctl enable --now rosdeck-robot-bridge.service
fi
if [[ "${ENABLE_FOXGLOVE}" -eq 1 ]]; then
  systemctl enable --now rosdeck-foxglove-bridge.service
fi
sleep 2
if ! systemctl is-active --quiet rosdeck-robot-bridge.service; then
  echo "Bridge failed to stay active. Recent logs:" >&2
  journalctl -u rosdeck-robot-bridge.service -n 80 --no-pager >&2 || true
  exit 1
fi
if [[ "${ENABLE_FOXGLOVE}" -eq 1 ]] && \
  ! systemctl is-active --quiet rosdeck-foxglove-bridge.service; then
  echo "Foxglove Bridge failed to stay active. Recent logs:" >&2
  journalctl -u rosdeck-foxglove-bridge.service -n 80 --no-pager >&2 || true
  exit 1
fi

if ! timeout 50 bash -c '
  set -e
  set -a
  [[ -f "$4" ]] && source "$4"
  set +a
  source "$1"
  [[ -f "$2" ]] && source "$2"
  "$5" "$6" "$3" rosdeck-robot-bridge.service
' _ "${ROS_SETUP}" "${INSTALL_PREFIX}/runtime/local_setup.bash" \
  "/${NODE_NAME}" "${INSTALL_PREFIX}/config/bridge.env" \
  "${INSTALL_PREFIX}/runtime/lib/rosdeck_robot_bridge/assert-product-bringup-health.sh" \
  "${BUNDLE_PROFILE}"; then
  echo "Product bringup failed its continuous graph/cgroup/status health check." >&2
  journalctl -u rosdeck-robot-bridge.service -n 80 --no-pager >&2 || true
  exit 1
fi

systemctl --no-pager --full status rosdeck-robot-bridge.service || true
echo "Offline deployment successful: profile=${BUNDLE_PROFILE}, model=${BUNDLE_ZSIBOT_MODEL:-n/a}, node=/${NODE_NAME}"
if [[ "${BUNDLE_PROFILE}" == "vbot" ]]; then
  echo "Boot autostart: registered in /userdata/startup.sh"
else
  echo "Boot autostart: enabled with persistent systemd (${INSTALL_PREFIX})"
fi
echo "Logs: journalctl -u rosdeck-robot-bridge -f"
if [[ "${ENABLE_FOXGLOVE}" -eq 1 ]]; then
  echo "Foxglove: ws://<orin-ip>:8765 (systemctl status rosdeck-foxglove-bridge)"
fi
