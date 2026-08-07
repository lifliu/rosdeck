#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
INSTALL_PREFIX="/opt/rosdeck"
PROFILE="vbot"
ROS_SETUP=""
CLEAN_CACHE=0

usage() {
  echo "Usage: sudo ./scripts/build.sh [--profile vbot|zsibot] [--ros-setup PATH] [--prefix PATH] [--clean]"
}

while (($#)); do
  case "$1" in
    --profile) PROFILE="${2:?missing profile}"; shift 2 ;;
    --ros-setup) ROS_SETUP="${2:?missing ROS setup path}"; shift 2 ;;
    --prefix) INSTALL_PREFIX="${2:?missing install prefix}"; shift 2 ;;
    --clean) CLEAN_CACHE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ! "${PROFILE}" =~ ^(vbot|zsibot)$ ]]; then
  echo "Unsupported profile: ${PROFILE}" >&2
  exit 2
fi
if [[ -z "${ROS_SETUP}" ]]; then
  for candidate in /app/script/env.sh /app/opt/ros/humble/setup.bash /opt/ros/humble/setup.bash; do
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

set +u
source "${ROS_SETUP}"
set -u
command -v ros2 >/dev/null 2>&1 || {
  echo "ros2 is unavailable after sourcing ${ROS_SETUP}." >&2
  exit 1
}
command -v colcon >/dev/null 2>&1 || {
  echo "colcon is required to build rosdeck_robot_bridge." >&2
  exit 1
}

if [[ "${PROFILE}" == "vbot" ]]; then
  ros2 pkg prefix function_msgs >/dev/null 2>&1 || {
    echo "function_msgs is missing from the sourced ROS environment." >&2
    exit 1
  }
  ros2 pkg prefix software_msgs >/dev/null 2>&1 || {
    echo "software_msgs is missing from the sourced ROS environment." >&2
    exit 1
  }
fi

install -d "${INSTALL_PREFIX}/src/rosdeck_robot_bridge" \
  "${INSTALL_PREFIX}/build" "${INSTALL_PREFIX}/install" "${INSTALL_PREFIX}/log"
if [[ "$(realpath "${PACKAGE_DIR}")" != "$(realpath "${INSTALL_PREFIX}/src/rosdeck_robot_bridge")" ]]; then
  cp -a "${PACKAGE_DIR}/." "${INSTALL_PREFIX}/src/rosdeck_robot_bridge/"
fi

COLCON_ARGS=(
  --base-paths "${INSTALL_PREFIX}/src"
  --build-base "${INSTALL_PREFIX}/build"
  --install-base "${INSTALL_PREFIX}/install"
  --merge-install
  --packages-select rosdeck_robot_bridge
)
if [[ "${CLEAN_CACHE}" -eq 1 ]]; then
  COLCON_ARGS+=(--cmake-clean-cache)
fi
if [[ "${PROFILE}" == "vbot" ]]; then
  VBOT_ADAPTER_OPTION=ON
else
  VBOT_ADAPTER_OPTION=OFF
fi
COLCON_ARGS+=(
  --cmake-args
  -DCMAKE_BUILD_TYPE=Release
  -DROSDECK_BUILD_VBOT_ADAPTER="${VBOT_ADAPTER_OPTION}"
)

echo "Building rosdeck_robot_bridge (${PROFILE}) with ${ROS_SETUP}"
colcon --log-base "${INSTALL_PREFIX}/log" build "${COLCON_ARGS[@]}"

BINARY="${INSTALL_PREFIX}/install/lib/rosdeck_robot_bridge/rosdeck_robot_bridge_node"
if [[ ! -x "${BINARY}" ]]; then
  echo "Build completed but the node executable was not installed: ${BINARY}" >&2
  exit 1
fi
echo "Build successful: ${BINARY}"
