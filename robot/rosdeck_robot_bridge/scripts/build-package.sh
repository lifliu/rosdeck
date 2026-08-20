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
SIGN_KEY=""

usage() {
  echo "Usage: ./scripts/build-package.sh [--profile vbot|zsibot] [--ros-setup PATH] [--output-dir PATH] [--vbot-msgs PATH] [--zsibot-sdk PATH --zsibot-model zsl-1|zsl-1w] [--sign-key GPG_KEY]"
  echo ""
  echo "The package ships a deterministic release manifest + SBOM (pinned"
  echo "source revisions, tool versions, ROS distro). Set SOURCE_DATE_EPOCH"
  echo "to pin build metadata; otherwise the last rosdeck commit time is"
  echo "used. --sign-key adds a detached GPG signature (<archive>.asc)."
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
    --sign-key) SIGN_KEY="${2:?missing GPG key}"; shift 2 ;;
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
SUPERVISOR_BINARY="${BUILD_ROOT}/install/lib/rosdeck_robot_bridge/rosdeck_safety_supervisor_node"
set +u
source "${BUILD_ROOT}/install/setup.bash"
set -u
for runtime_binary in "${BINARY}" "${SUPERVISOR_BINARY}"; do
  if [[ ! -x "${runtime_binary}" ]]; then
    echo "Build completed but a product runtime executable is missing: ${runtime_binary}" >&2
    exit 1
  fi
  if LD_LIBRARY_PATH="${BUILD_ROOT}/install/lib:${LD_LIBRARY_PATH:-}" \
    ldd "${runtime_binary}" | grep -q 'not found'; then
    echo "A product runtime executable has unresolved shared-library dependencies:" >&2
    LD_LIBRARY_PATH="${BUILD_ROOT}/install/lib:${LD_LIBRARY_PATH:-}" \
      ldd "${runtime_binary}" >&2
    exit 1
  fi
done

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
install -d "${STAGE}/bin" "${STAGE}/config" "${STAGE}/templates" \
  "${STAGE}/runtime" "${STAGE}/tools" "${STAGE}/lib"
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

install -m 0755 "${SCRIPT_DIR}/release_artifacts.py" \
  "${STAGE}/tools/release_artifacts.py"

# A/B release management: the sourceable core library (deploy.sh loads it
# from lib/) and ota.sh (robot-side install/rollback/status, installed to
# ${PREFIX}/bin/ by every deploy/OTA run).
install -m 0644 "${SCRIPT_DIR}/deploy-core.sh" "${STAGE}/lib/deploy-core.sh"
install -m 0755 "${SCRIPT_DIR}/ota.sh" "${STAGE}/ota.sh"

# Reproducible metadata: honor SOURCE_DATE_EPOCH, else fall back to the
# last rosdeck commit time, else the package.xml mtime. The origin is
# recorded in the manifest so a reader knows how strong the guarantee is.
SOURCE_EPOCH="${SOURCE_DATE_EPOCH:-}"
EPOCH_ORIGIN=""
if [[ -n "${SOURCE_EPOCH}" ]]; then
  EPOCH_ORIGIN="env"
elif git -C "${PACKAGE_DIR}" log -1 --format=%ct >/dev/null 2>&1; then
  SOURCE_EPOCH="$(git -C "${PACKAGE_DIR}" log -1 --format=%ct)"
  EPOCH_ORIGIN="git"
else
  SOURCE_EPOCH="$(stat -c %Y "${PACKAGE_DIR}/package.xml")"
  EPOCH_ORIGIN="file-mtime"
fi

# Pin every build input into the facts file. Git checkouts pin to their
# HEAD sha (+ dirty flag); vendor drops without VCS pin to a content hash.
SOURCES_ARGS=(
  "rosdeck=${PACKAGE_DIR}|https://github.com/lifliu/rosdeck.git"
  "omni_robot_interfaces=${BUILD_ROOT}/src/omni_robot_interfaces|https://github.com/lifliu/omni_robot_interfaces.git"
  "omni_slam_interfaces=${BUILD_ROOT}/src/omni_slam_interfaces|https://github.com/YanYaoyuan/omni_slam.git"
  "omni_mission_manager=part-of:rosdeck"
)
if [[ "${PROFILE}" == "vbot" ]]; then
  SOURCES_ARGS+=("vbot_ros2_msgs=${VBOT_MSGS}|https://github.com/VitaDynamics/vbot_ros2_msgs.git")
else
  SOURCES_ARGS+=("zsibot_sdk=${ZSIBOT_SDK}")
fi

FACTS_FILE="${BUILD_ROOT}/release-facts.json"
RELEASE_TOOL_ARGS=(facts
  --stage "${STAGE}"
  --bundle-name "${BUNDLE_NAME}"
  --version "${VERSION}"
  --profile "${PROFILE}"
  --arch "${ARCH}"
  --distro "${ROS_VERSION_NAME}"
  --epoch "${SOURCE_EPOCH}"
  --epoch-origin "${EPOCH_ORIGIN}"
)
if [[ -n "${ZSIBOT_MODEL}" ]]; then
  RELEASE_TOOL_ARGS+=(--model "${ZSIBOT_MODEL}")
fi
if [[ -n "${SIGN_KEY}" ]]; then
  RELEASE_TOOL_ARGS+=(--sign-key "${SIGN_KEY}")
fi
RELEASE_TOOL_ARGS+=(--output "${FACTS_FILE}")
RELEASE_TOOL_ARGS+=("${SOURCES_ARGS[@]}")
python3 "${SCRIPT_DIR}/release_artifacts.py" "${RELEASE_TOOL_ARGS[@]}"

# Manifest + SBOM go into the stage (tied to the bundle by hash), then the
# deterministic archive + checksum are written to the output directory.
install -d "${OUTPUT_DIR}"
OUTPUT_DIR="$(cd -- "${OUTPUT_DIR}" && pwd)"
python3 "${SCRIPT_DIR}/release_artifacts.py" make \
  --facts "${FACTS_FILE}" \
  --output-dir "${OUTPUT_DIR}"

ARCHIVE="${OUTPUT_DIR}/${BUNDLE_NAME}.tar.gz"
echo "Offline deployment package created:"
echo "  ${ARCHIVE}"
echo "  ${ARCHIVE}.sha256"
if [[ -n "${SIGN_KEY}" ]]; then
  echo "  ${ARCHIVE}.asc"
fi
echo "Copy the archive (+ checksum/signature) to the robot, extract it,"
echo "then run: sudo ./deploy.sh"
echo "Later upgrades: sudo ${BUNDLE_NAME}/ota.sh install <new-archive>.tar.gz"
echo "  (or on the robot: sudo /path/to/install-prefix/bin/ota.sh)"
echo "Verify with: python3 tools/release_artifacts.py verify <archive>.tar.gz"
