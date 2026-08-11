#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
PROFILE="vbot"
ROS_SETUP=""
OUTPUT_DIR="${PACKAGE_DIR}/dist"
VBOT_MSGS=""
ZSIBOT_SDK=""
ZSIBOT_MODEL=""

usage() {
  echo "Usage: ./scripts/build-package.sh [--profile vbot|zsibot] [--ros-setup PATH] [--output-dir PATH] [--vbot-msgs PATH] [--zsibot-sdk PATH --zsibot-model zsl-1|zsl-1w]"
}

is_vbot_msgs_tree() {
  local candidate="$1"
  [[ -d "${candidate}/function_msgs" && \
     -d "${candidate}/software_msgs" && \
     -d "${candidate}/foxglove_msgs" ]]
}

while (($#)); do
  case "$1" in
    --profile) PROFILE="${2:?missing profile}"; shift 2 ;;
    --ros-setup) ROS_SETUP="${2:?missing ROS setup path}"; shift 2 ;;
    --output-dir) OUTPUT_DIR="${2:?missing output directory}"; shift 2 ;;
    --vbot-msgs) VBOT_MSGS="${2:?missing vbot_ros2_msgs path}"; shift 2 ;;
    --zsibot-sdk) ZSIBOT_SDK="${2:?missing Zsibot SDK path}"; shift 2 ;;
    --zsibot-model) ZSIBOT_MODEL="${2:?missing Zsibot model}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ! "${PROFILE}" =~ ^(vbot|zsibot)$ ]]; then
  echo "Unsupported profile: ${PROFILE}" >&2
  exit 2
fi
if [[ "${PROFILE}" == "vbot" && ( -n "${ZSIBOT_SDK}" || -n "${ZSIBOT_MODEL}" ) ]]; then
  echo "--zsibot-sdk/--zsibot-model are only valid with --profile zsibot." >&2
  exit 2
fi
if [[ "${PROFILE}" == "zsibot" && ! "${ZSIBOT_MODEL}" =~ ^(zsl-1|zsl-1w)$ ]]; then
  echo "Profile zsibot requires --zsibot-model zsl-1 or zsl-1w." >&2
  exit 2
fi
if [[ -z "${ROS_SETUP}" ]]; then
  if [[ "${PROFILE}" == "vbot" ]]; then
    ROS_CANDIDATES=(
      /app/script/env.sh
      /app/opt/ros/humble/setup.bash
      /opt/ros/humble/setup.bash
    )
  else
    ROS_CANDIDATES=(
      /opt/ros/humble/setup.bash
      /app/opt/ros/humble/setup.bash
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

BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/rosdeck-package.XXXXXX")"
cleanup() {
  rm -rf -- "${BUILD_ROOT}"
}
trap cleanup EXIT

set +u
source "${ROS_SETUP}"
set -u
command -v colcon >/dev/null 2>&1 || {
  echo "colcon is required on the development/build host (not on the deployment target)." >&2
  exit 1
}

BUILD_SETUP="${ROS_SETUP}"
if [[ "${PROFILE}" == "vbot" ]]; then
  if [[ -n "${VBOT_MSGS}" ]] && ! is_vbot_msgs_tree "${VBOT_MSGS}"; then
    echo "Invalid --vbot-msgs path: ${VBOT_MSGS}" >&2
    echo "Expected these directories:" >&2
    echo "  ${VBOT_MSGS}/function_msgs" >&2
    echo "  ${VBOT_MSGS}/software_msgs" >&2
    echo "  ${VBOT_MSGS}/foxglove_msgs" >&2
    exit 1
  fi

  if [[ -z "${VBOT_MSGS}" ]]; then
    for candidate in \
      "${PACKAGE_DIR}/../../sdk/vbot_ros2_msgs" \
      "${PACKAGE_DIR}/../vbot_ros2_msgs" \
      "${PACKAGE_DIR}/../../vbot_ros2_msgs" \
      "${HOME}/robot/vbot_ros2_msgs" \
      "${HOME}/vbot_ros2_msgs"; do
      if is_vbot_msgs_tree "${candidate}"; then
        VBOT_MSGS="$(cd -- "${candidate}" && pwd)"
        echo "Auto-detected VBot interfaces: ${VBOT_MSGS}"
        break
      fi
    done
  fi

  if [[ -z "${VBOT_MSGS}" ]]; then
    echo "VBot interfaces are not installed and vbot_ros2_msgs was not found." >&2
    echo "Clone it next to rosdeck_robot_bridge:" >&2
    echo "  cd $(dirname "${PACKAGE_DIR}")" >&2
    echo "  git clone https://github.com/VitaDynamics/vbot_ros2_msgs.git" >&2
    echo "Then rerun build-package.sh without --vbot-msgs." >&2
    exit 1
  fi

  install -d "${BUILD_ROOT}/src"
  cp -a "${VBOT_MSGS}/function_msgs" "${BUILD_ROOT}/src/"
  cp -a "${VBOT_MSGS}/software_msgs" "${BUILD_ROOT}/src/"
  cp -a "${VBOT_MSGS}/foxglove_msgs" "${BUILD_ROOT}/src/"
  colcon --log-base "${BUILD_ROOT}/log" build \
    --base-paths "${BUILD_ROOT}/src" \
    --build-base "${BUILD_ROOT}/build" \
    --install-base "${BUILD_ROOT}/install" \
    --merge-install \
    --packages-select foxglove_msgs function_msgs software_msgs \
    --cmake-args -DCMAKE_BUILD_TYPE=Release
  BUILD_SETUP="${BUILD_ROOT}/install/setup.bash"
else
  if [[ -z "${ZSIBOT_SDK}" ]]; then
    for candidate in \
      "${PACKAGE_DIR}/../../sdk/zsibot_sdk-main" \
      "${PACKAGE_DIR}/../zsibot_sdk-main" \
      "${PACKAGE_DIR}/../../zsibot_sdk-main"; do
      if [[ -f "${candidate}/include/${ZSIBOT_MODEL}/highlevel.h" ]]; then
        ZSIBOT_SDK="$(cd -- "${candidate}" && pwd)"
        echo "Auto-detected Zsibot SDK: ${ZSIBOT_SDK}"
        break
      fi
    done
  fi
  if [[ -z "${ZSIBOT_SDK}" || ! -f "${ZSIBOT_SDK}/include/${ZSIBOT_MODEL}/highlevel.h" ]]; then
    echo "Zsibot SDK was not found; pass --zsibot-sdk /actual/path/zsibot_sdk-main." >&2
    exit 1
  fi
fi

BUILD_ARGS=(
  --profile "${PROFILE}"
  --ros-setup "${BUILD_SETUP}"
  --prefix "${BUILD_ROOT}"
  --clean
)
if [[ "${PROFILE}" == "zsibot" ]]; then
  BUILD_ARGS+=(--zsibot-sdk "${ZSIBOT_SDK}" --zsibot-model "${ZSIBOT_MODEL}")
fi
"${SCRIPT_DIR}/build.sh" \
  "${BUILD_ARGS[@]}"

BINARY="${BUILD_ROOT}/install/lib/rosdeck_robot_bridge/rosdeck_robot_bridge_node"
set +u
source "${BUILD_ROOT}/install/setup.bash"
set -u
if LD_LIBRARY_PATH="${BUILD_ROOT}/install/lib:${LD_LIBRARY_PATH:-}" \
  ldd "${BINARY}" | grep -q 'not found'; then
  echo "The compiled node has unresolved shared-library dependencies:" >&2
  LD_LIBRARY_PATH="${BUILD_ROOT}/install/lib:${LD_LIBRARY_PATH:-}" ldd "${BINARY}" >&2
  exit 1
fi

VERSION="$(sed -n 's:.*<version>\([^<]*\)</version>.*:\1:p' "${PACKAGE_DIR}/package.xml" | head -1)"
ARCH="$(uname -m)"
ROS_VERSION_NAME="${ROS_DISTRO:-humble}"
PROFILE_LABEL="${PROFILE}"
if [[ "${PROFILE}" == "zsibot" ]]; then
  PROFILE_LABEL="${PROFILE}-${ZSIBOT_MODEL}"
fi
BUNDLE_NAME="rosdeck-robot-bridge-${VERSION}-${PROFILE_LABEL}-${ARCH}-${ROS_VERSION_NAME}"
STAGE_PARENT="${BUILD_ROOT}/bundle"
STAGE="${STAGE_PARENT}/${BUNDLE_NAME}"
install -d "${STAGE}/bin" "${STAGE}/config" "${STAGE}/templates" "${STAGE}/runtime"
install -m 0755 "${BINARY}" "${STAGE}/bin/rosdeck_robot_bridge_node"
cp -a "${BUILD_ROOT}/install/." "${STAGE}/runtime/"
install -m 0644 "${PACKAGE_DIR}/config/${PROFILE}.yaml" "${STAGE}/config/bridge.yaml"
install -m 0755 "${PACKAGE_DIR}/scripts/deploy-prebuilt.sh" "${STAGE}/deploy.sh"
install -m 0755 "${PACKAGE_DIR}/scripts/uninstall.sh" "${STAGE}/uninstall.sh"
install -m 0644 "${PACKAGE_DIR}/scripts/run-prebuilt.in" "${STAGE}/templates/run-bridge.in"
install -m 0644 "${PACKAGE_DIR}/scripts/run-foxglove.in" "${STAGE}/templates/run-foxglove.in"
install -m 0644 "${PACKAGE_DIR}/scripts/bootstrap-service.in" \
  "${STAGE}/templates/bootstrap-service.in"
install -m 0644 "${PACKAGE_DIR}/systemd/rosdeck-robot-bridge.service.in" \
  "${STAGE}/templates/rosdeck-robot-bridge.service.in"
install -m 0644 "${PACKAGE_DIR}/systemd/rosdeck-foxglove-bridge.service.in" \
  "${STAGE}/templates/rosdeck-foxglove-bridge.service.in"

cat > "${STAGE}/manifest.env" <<EOF
BUNDLE_VERSION=${VERSION}
BUNDLE_PROFILE=${PROFILE}
BUNDLE_ARCH=${ARCH}
BUNDLE_ROS_DISTRO=${ROS_VERSION_NAME}
BUNDLE_ZSIBOT_MODEL=${ZSIBOT_MODEL}
EOF

install -d "${OUTPUT_DIR}"
OUTPUT_DIR="$(cd -- "${OUTPUT_DIR}" && pwd)"
ARCHIVE="${OUTPUT_DIR}/${BUNDLE_NAME}.tar.gz"
tar -C "${STAGE_PARENT}" -czf "${ARCHIVE}" "${BUNDLE_NAME}"
ARCHIVE_FILE="$(basename "${ARCHIVE}")"
(
  cd "${OUTPUT_DIR}"
  sha256sum "${ARCHIVE_FILE}" > "${ARCHIVE_FILE}.sha256"
)

echo "Offline deployment package created:"
echo "  ${ARCHIVE}"
echo "  ${ARCHIVE}.sha256"
echo "Copy the archive to the robot, extract it, then run: sudo ./deploy.sh"
