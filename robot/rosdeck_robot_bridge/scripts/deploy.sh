#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
INSTALL_PREFIX=""
PROFILE="vbot"
ROS_SETUP=""
ENABLE_SERVICE=1
ENABLE_FOXGLOVE=-1
CLEAN_CACHE=0
NODE_NAME="rosdeck_robot_bridge"
ZSIBOT_SDK=""
ZSIBOT_MODEL=""
INTERFACES_DIR=""
SLAM_DIR=""

usage() {
  echo "Usage: sudo ./scripts/deploy.sh [--profile vbot|zsibot] [--ros-setup PATH] [--prefix PATH] [--zsibot-sdk PATH --zsibot-model zsl-1|zsl-1w] [--interfaces-dir PATH] [--slam-dir PATH] [--clean] [--no-start] [--no-foxglove]"
}

while (($#)); do
  case "$1" in
    --profile) PROFILE="${2:?missing profile}"; shift 2 ;;
    --ros-setup) ROS_SETUP="${2:?missing ROS setup path}"; shift 2 ;;
    --prefix) INSTALL_PREFIX="${2:?missing install prefix}"; shift 2 ;;
    --zsibot-sdk) ZSIBOT_SDK="${2:?missing Zsibot SDK path}"; shift 2 ;;
    --zsibot-model) ZSIBOT_MODEL="${2:?missing Zsibot model}"; shift 2 ;;
    --interfaces-dir) INTERFACES_DIR="${2:?missing interfaces dir}"; shift 2 ;;
    --slam-dir) SLAM_DIR="${2:?missing slam dir}"; shift 2 ;;
    --clean) CLEAN_CACHE=1; shift ;;
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
if [[ ! "${PROFILE}" =~ ^(vbot|zsibot)$ ]]; then
  echo "Unsupported profile: ${PROFILE}" >&2
  exit 2
fi
if [[ "${PROFILE}" == "zsibot" ]]; then
  NODE_NAME="rosdeck_robot_bridge_zsibot"
  if [[ ! "${ZSIBOT_MODEL}" =~ ^(zsl-1|zsl-1w)$ ]]; then
    echo "Profile zsibot requires --zsibot-model zsl-1 or zsl-1w." >&2
    exit 2
  fi
  : "${ZSIBOT_SDK:?profile zsibot requires --zsibot-sdk PATH}"
fi
if [[ "${ENABLE_FOXGLOVE}" -lt 0 ]]; then
  [[ "${PROFILE}" == "zsibot" ]] && ENABLE_FOXGLOVE=1 || ENABLE_FOXGLOVE=0
fi
if [[ -z "${INSTALL_PREFIX}" ]]; then
  if [[ "${PROFILE}" == "vbot" ]]; then
    INSTALL_PREFIX="/userdata/rosdeck"
  else
    INSTALL_PREFIX="/opt/rosdeck"
  fi
fi
if [[ -z "${ROS_SETUP}" ]]; then
  if [[ "${PROFILE}" == "vbot" ]]; then
    ROS_CANDIDATES=(/app/script/env.sh /app/opt/ros/humble/setup.bash /opt/ros/humble/setup.bash)
  else
    ROS_CANDIDATES=(/opt/ros/humble/setup.bash /app/opt/ros/humble/setup.bash)
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

BUILD_ARGS=(--profile "${PROFILE}" --ros-setup "${ROS_SETUP}" --prefix "${INSTALL_PREFIX}")
if [[ "${PROFILE}" == "zsibot" ]]; then
  BUILD_ARGS+=(--zsibot-sdk "${ZSIBOT_SDK}" --zsibot-model "${ZSIBOT_MODEL}")
fi
if [[ -n "${INTERFACES_DIR}" ]]; then
  BUILD_ARGS+=(--interfaces-dir "${INTERFACES_DIR}")
fi
if [[ -n "${SLAM_DIR}" ]]; then
  BUILD_ARGS+=(--slam-dir "${SLAM_DIR}")
fi
if [[ "${CLEAN_CACHE}" -eq 1 ]]; then
  BUILD_ARGS+=(--clean)
fi
"${SCRIPT_DIR}/build.sh" "${BUILD_ARGS[@]}"

set +u
source "${ROS_SETUP}"
source "${INSTALL_PREFIX}/install/setup.bash"
set -u
if [[ "${ENABLE_FOXGLOVE}" -eq 1 ]] && ! ros2 pkg prefix foxglove_bridge >/dev/null 2>&1; then
  echo "foxglove_bridge is required for mobile connections but is not installed." >&2
  echo "Install it first: sudo apt install ros-${ROS_DISTRO:-humble}-foxglove-bridge" >&2
  exit 1
fi

install -d "${INSTALL_PREFIX}/bin" "${INSTALL_PREFIX}/config" \
  "${INSTALL_PREFIX}/systemd"
if [[ -f "${INSTALL_PREFIX}/config/bridge.yaml" ]]; then
  cp -a "${INSTALL_PREFIX}/config/bridge.yaml" \
    "${INSTALL_PREFIX}/config/bridge.yaml.previous"
fi
install -m 0644 "${PACKAGE_DIR}/config/${PROFILE}.yaml" \
  "${INSTALL_PREFIX}/config/bridge.yaml"
if [[ ! -f "${INSTALL_PREFIX}/config/bridge.env" ]]; then
  if [[ "${PROFILE}" == "vbot" ]]; then
    echo "RMW_IMPLEMENTATION=${RMW_IMPLEMENTATION:-rmw_zenoh_cpp}" \
      > "${INSTALL_PREFIX}/config/bridge.env"
    chmod 0644 "${INSTALL_PREFIX}/config/bridge.env"
  else
    install -m 0644 /dev/null "${INSTALL_PREFIX}/config/bridge.env"
  fi
fi
DEFAULT_ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-0}"
DEFAULT_RMW_IMPLEMENTATION="${RMW_IMPLEMENTATION:-rmw_zenoh_cpp}"
if [[ "${PROFILE}" == "zsibot" ]]; then
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
  -e "s#@PROFILE@#${PROFILE}#g" \
  "${PACKAGE_DIR}/scripts/run-bridge.in" > "${INSTALL_PREFIX}/bin/run-rosdeck-robot-bridge"
chmod 0755 "${INSTALL_PREFIX}/bin/run-rosdeck-robot-bridge"
if [[ "${ENABLE_FOXGLOVE}" -eq 1 ]]; then
  sed \
    -e "s#@ROS_SETUP@#${ROS_SETUP}#g" \
    -e "s#@INSTALL_PREFIX@#${INSTALL_PREFIX}#g" \
    "${PACKAGE_DIR}/scripts/run-foxglove.in" \
    > "${INSTALL_PREFIX}/bin/run-rosdeck-foxglove-bridge"
  chmod 0755 "${INSTALL_PREFIX}/bin/run-rosdeck-foxglove-bridge"
fi

sed "s#@INSTALL_PREFIX@#${INSTALL_PREFIX}#g" \
  "${PACKAGE_DIR}/scripts/bootstrap-service.in" \
  > "${INSTALL_PREFIX}/bin/bootstrap-rosdeck-service"
chmod 0755 "${INSTALL_PREFIX}/bin/bootstrap-rosdeck-service"

sed "s#@INSTALL_PREFIX@#${INSTALL_PREFIX}#g" \
  "${PACKAGE_DIR}/systemd/rosdeck-robot-bridge.service.in" \
  > "${INSTALL_PREFIX}/systemd/rosdeck-robot-bridge.service"
if [[ "${ENABLE_FOXGLOVE}" -eq 1 ]]; then
  sed "s#@INSTALL_PREFIX@#${INSTALL_PREFIX}#g" \
    "${PACKAGE_DIR}/systemd/rosdeck-foxglove-bridge.service.in" \
    > "${INSTALL_PREFIX}/systemd/rosdeck-foxglove-bridge.service"
fi

if [[ "${PROFILE}" == "vbot" ]]; then
  install -d "${INSTALL_PREFIX}/log" /userdata /run/systemd/system /etc/systemd/system
  if [[ ! -f /userdata/startup.sh ]]; then
    printf '%s\n' '#!/usr/bin/env bash' '' '# ROSDECK ROBOT BRIDGE' \
      "${INSTALL_PREFIX}/bin/bootstrap-rosdeck-service >>${INSTALL_PREFIX}/log/bootstrap.log 2>&1 &" \
      > /userdata/startup.sh
  elif ! grep -Fq '# ROSDECK ROBOT BRIDGE' /userdata/startup.sh; then
    printf '%s\n' '' '# ROSDECK ROBOT BRIDGE' \
      "${INSTALL_PREFIX}/bin/bootstrap-rosdeck-service >>${INSTALL_PREFIX}/log/bootstrap.log 2>&1 &" \
      >> /userdata/startup.sh
  fi
  chmod 0755 /userdata/startup.sh
  install -m 0644 "${INSTALL_PREFIX}/systemd/rosdeck-robot-bridge.service" \
    /run/systemd/system/rosdeck-robot-bridge.service
else
  install -d /etc/systemd/system
fi
install -m 0644 "${INSTALL_PREFIX}/systemd/rosdeck-robot-bridge.service" \
  /etc/systemd/system/rosdeck-robot-bridge.service
chmod 0644 /etc/systemd/system/rosdeck-robot-bridge.service
if [[ "${ENABLE_FOXGLOVE}" -eq 1 ]]; then
  install -m 0644 "${INSTALL_PREFIX}/systemd/rosdeck-foxglove-bridge.service" \
    /etc/systemd/system/rosdeck-foxglove-bridge.service
fi

systemctl daemon-reload
if [[ "${ENABLE_SERVICE}" -eq 0 ]]; then
  echo "Deployment complete without starting the service in this boot."
  exit 0
fi

if [[ "${PROFILE}" == "vbot" ]]; then
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

systemctl --no-pager --full status rosdeck-robot-bridge.service || true
if timeout 50 bash -c '
  set -e
  set -a
  [[ -f "$4" ]] && source "$4"
  set +a
  source "$1"
  source "$2"
  "$5" "$6" "$3" rosdeck-robot-bridge.service
' _ "${ROS_SETUP}" "${INSTALL_PREFIX}/install/setup.bash" "/${NODE_NAME}" \
  "${INSTALL_PREFIX}/config/bridge.env" \
  "${INSTALL_PREFIX}/install/lib/rosdeck_robot_bridge/assert-product-bringup-health.sh" \
  "${PROFILE}"; then
  echo "Product health check passed for /${NODE_NAME} (${PROFILE})"
else
  echo "Product bringup failed its continuous graph/cgroup/status health check." >&2
  echo "Check RMW settings in ${INSTALL_PREFIX}/config/bridge.env and inspect the journal." >&2
  exit 1
fi
echo "Deployment successful: profile=${PROFILE}, node=/${NODE_NAME}"
if [[ "${PROFILE}" == "vbot" ]]; then
  echo "Boot autostart: registered in /userdata/startup.sh"
else
  echo "Boot autostart: enabled with persistent systemd"
fi
echo "Logs: journalctl -u rosdeck-robot-bridge -f"
if [[ "${ENABLE_FOXGLOVE}" -eq 1 ]]; then
  echo "Foxglove: ws://<orin-ip>:8765 (systemctl status rosdeck-foxglove-bridge)"
fi
