#!/usr/bin/env bash
set -euo pipefail
# ota.sh — OTA upgrade / rollback / status for the rosdeck robot bridge.
#
# Two copies exist on a robot:
#   $PREFIX/bin/ota.sh   installed by deploy/OTA (this is the one to use;
#                        it resolves the install prefix from its own path)
#   <bundle>/ota.sh      shipped inside every release bundle (used to
#                        bootstrap the very first A/B layout via deploy.sh)
#
#   sudo ota.sh install <archive.tar.gz> [--signature <archive>.asc]
#                        [--keep N] [--no-start] [--no-foxglove]
#                        [--ros-setup PATH] [--prefix PATH]
#   sudo ota.sh rollback
#   ota.sh status
#
# install  verifies the archive with the ACTIVE release's own verifier
#          (sha256 sidecar + optional GPG signature), extracts it, stages
#          it as a new release slot, switches to it and health-checks it.
#          A failed check rolls back to the previous release automatically.
#          The first install on a robot is NOT done here — use the bundle's
#          deploy.sh, which builds the A/B layout from an in-place tree.
# rollback swaps `current` and `previous` and restarts the bridge.
# status   prints the current, previous and retained releases.

usage() {
  cat <<'EOF'
Usage:
  sudo ota.sh install <archive.tar.gz> [--signature <archive.tar.gz.asc>]
                      [--keep N] [--no-start] [--no-foxglove]
                      [--ros-setup PATH] [--prefix PATH]
  sudo ota.sh rollback
  ota.sh status

Commands:
  install   Verify and install a release bundle, switch to it, health-check.
            A failed startup/health check rolls back automatically.
  rollback  Switch back to the previous release and restart the bridge.
  status    Show current/previous release and retained slots.
EOF
}

COMMAND=""
ARCHIVE=""
SIGNATURE=""
KEEP=3
ENABLE_SERVICE=1
ENABLE_FOXGLOVE=""
ROS_SETUP=""
INSTALL_PREFIX=""

while (($#)); do
  case "$1" in
    install)
      COMMAND="install"; shift ;;
    rollback)
      COMMAND="rollback"; shift ;;
    status)
      COMMAND="status"; shift ;;
    --signature)
      SIGNATURE="${2:?--signature requires a path}"; shift 2 ;;
    --keep)
      KEEP="${2:?--keep requires a number}"; shift 2 ;;
    --no-start)
      ENABLE_SERVICE=0; shift ;;
    --no-foxglove)
      ENABLE_FOXGLOVE=0; shift ;;
    --ros-setup)
      ROS_SETUP="${2:?--ros-setup requires a path}"; shift 2 ;;
    --prefix)
      INSTALL_PREFIX="${2:?--prefix requires a path}"; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2 ;;
    *)
      if [[ -z "${ARCHIVE}" ]]; then
        ARCHIVE="$1"; shift
      else
        echo "Unknown argument: $1" >&2
        usage >&2
        exit 2
      fi ;;
  esac
done

if [[ -z "${COMMAND}" ]]; then
  usage >&2
  exit 2
fi
if [[ "${COMMAND}" == "install" && -z "${ARCHIVE}" ]]; then
  echo "install requires an archive path" >&2
  exit 2
fi
case "${KEEP}" in
  ''|*[!0-9]*)
    echo "--keep must be a positive integer, got: ${KEEP}" >&2
    exit 2 ;;
esac
if [[ "${KEEP}" -lt 2 ]]; then
  echo "--keep must be at least 2 (current + previous)" >&2
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CORE=""
# Lookup order: robot install ($PREFIX/bin/ota.sh -> $PREFIX/lib),
# release bundle (bundle/ota.sh -> bundle/lib), repository checkout
# (scripts/ota.sh next to scripts/deploy-core.sh, used by the E2E test).
for candidate in "${SCRIPT_DIR}/lib/deploy-core.sh" \
  "${SCRIPT_DIR}/../lib/deploy-core.sh" \
  "${SCRIPT_DIR}/deploy-core.sh"; do
  if [[ -f "${candidate}" ]]; then
    CORE="$(cd -- "$(dirname -- "${candidate}")" && pwd)/$(basename -- "${candidate}")"
    break
  fi
done
if [[ -z "${CORE}" ]]; then
  echo "deploy-core.sh not found next to this script." >&2
  exit 1
fi
# shellcheck source=/dev/null
source "${CORE}"

# Prefix resolution order: --prefix flag, the directory this ota.sh was
# installed into (robot copy: $PREFIX/bin), the standard profile defaults.
if [[ -z "${INSTALL_PREFIX}" ]]; then
  parent="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
  if [[ -d "${parent}/releases" || -L "${parent}/current" ]]; then
    INSTALL_PREFIX="${parent}"
  fi
fi
if [[ -z "${INSTALL_PREFIX}" ]]; then
  found=()
  for candidate in /userdata/rosdeck /opt/rosdeck; do
    if [[ -L "${candidate}/current" ]]; then
      found+=("${candidate}")
    fi
  done
  if [[ "${#found[@]}" -eq 1 ]]; then
    INSTALL_PREFIX="${found[0]}"
  elif [[ "${#found[@]}" -gt 1 ]]; then
    echo "Multiple A/B installs found (${found[*]}); pass --prefix PATH." >&2
    exit 1
  fi
fi
if [[ -z "${INSTALL_PREFIX}" ]]; then
  echo "Cannot determine the install prefix; pass --prefix PATH." >&2
  exit 1
fi

need_root() {
  # ROSDECK_OTA_ALLOW_NONROOT=1 is honored only by the offline E2E test
  # (test/test_ota_e2e.sh), where every write target is redirected into a
  # temp tree via the ROSDECK_* overrides.
  if [[ "$(id -u)" -ne 0 && "${ROSDECK_OTA_ALLOW_NONROOT:-}" != "1" ]]; then
    echo "This command must run as root (sudo ota.sh ...)." >&2
    exit 1
  fi
}

need_ab_layout() {
  if [[ ! -L "${INSTALL_PREFIX}/current" ]]; then
    echo "No A/B layout under ${INSTALL_PREFIX} (current symlink missing)." >&2
    echo "Deploy the first release with the bundle's deploy.sh, not ota.sh." >&2
    exit 1
  fi
}

# Resolves the ROS setup file to use for health checks and stores it in
# ROS_SETUP. The candidate order depends on the ACTIVE release's profile
# (zsibot images mount ROS under /opt/ros, vbot under /app).
resolve_ros_setup() {
  local profile="" distro=""
  profile="$(. "${INSTALL_PREFIX}/current/manifest.env" 2>/dev/null \
    && printf '%s' "${BUNDLE_PROFILE:-}" || true)"
  distro="$(. "${INSTALL_PREFIX}/current/manifest.env" 2>/dev/null \
    && printf '%s' "${BUNDLE_ROS_DISTRO:-}" || true)"
  if [[ -z "${distro}" ]]; then
    distro="humble"
  fi
  local candidate
  if [[ -n "${ROS_SETUP}" ]]; then
    candidate="${ROS_SETUP}"
  elif [[ "${profile}" == "zsibot" ]]; then
    candidate="/opt/ros/${distro}/setup.bash"
    if [[ ! -f "${candidate}" ]]; then
      candidate="/app/opt/ros/${distro}/setup.bash"
    fi
    if [[ ! -f "${candidate}" ]]; then
      candidate="/app/script/env.sh"
    fi
  else
    candidate="/app/script/env.sh"
    if [[ ! -f "${candidate}" ]]; then
      candidate="/app/opt/ros/${distro}/setup.bash"
    fi
    if [[ ! -f "${candidate}" ]]; then
      candidate="/opt/ros/${distro}/setup.bash"
    fi
  fi
  if [[ ! -f "${candidate}" ]]; then
    rosdeck_core_die "ROS setup file not found: ${candidate} (pass --ros-setup)"
  fi
  ROS_SETUP="${candidate}"
}

node_name_for_profile() {
  case "$1" in
    zsibot) printf 'rosdeck_robot_bridge_zsibot\n' ;;
    *) printf 'rosdeck_robot_bridge\n' ;;
  esac
}

case "${COMMAND}" in
  status)
    if [[ ! -d "${INSTALL_PREFIX}/releases" && ! -L "${INSTALL_PREFIX}/current" ]]; then
      echo "No A/B layout under ${INSTALL_PREFIX}." >&2
      exit 1
    fi
    rosdeck_ab_status "${INSTALL_PREFIX}"
    ;;

  rollback)
    need_root
    need_ab_layout
    if ! rosdeck_ab_has_previous "${INSTALL_PREFIX}"; then
      rosdeck_core_die "no previous release to roll back to"
    fi
    resolve_ros_setup
    prev_profile="$(. "${INSTALL_PREFIX}/previous/manifest.env" 2>/dev/null \
      && printf '%s' "${BUNDLE_PROFILE:-}" || true)"
    [[ -n "${prev_profile}" ]] \
      || rosdeck_core_die "previous release is missing manifest.env (pre-manifest install); restore it manually (see README)"
    prev_foxglove=1
    if [[ "${prev_profile}" == "vbot" ]]; then
      prev_foxglove=0
    fi
    prev_node="$(node_name_for_profile "${prev_profile}")"
    echo "Rolling back to previous release..."
    rosdeck_ab_rollback "${INSTALL_PREFIX}"
    if ! rosdeck_service_apply "${prev_profile}" "${prev_foxglove}" \
      || ! rosdeck_health_check "${INSTALL_PREFIX}" "${ROS_SETUP}" \
        "${prev_node}" "${prev_profile}"; then
      rosdeck_core_die "rollback did not restore a healthy service"
    fi
    echo "Rollback complete."
    rosdeck_ab_status "${INSTALL_PREFIX}"
    ;;

  install)
    need_root
    need_ab_layout
    if [[ ! -f "${ARCHIVE}" ]]; then
      rosdeck_core_die "archive not found: ${ARCHIVE}"
    fi
    verifier="${INSTALL_PREFIX}/current/tools/release_artifacts.py"
    if [[ ! -f "${verifier}" ]]; then
      rosdeck_core_die "active release has no OTA verifier (tools/release_artifacts.py); install a modern release first with its deploy.sh"
    fi

    verify_note="sha256 sidecar"
    if [[ -n "${SIGNATURE}" ]]; then
      if [[ ! -f "${SIGNATURE}" ]]; then
        rosdeck_core_die "signature not found: ${SIGNATURE}"
      fi
      verify_note="sha256 sidecar + GPG signature"
    fi
    echo "Verifying archive (${verify_note}): ${ARCHIVE}"
    verify_args=(verify "${ARCHIVE}")
    if [[ -n "${SIGNATURE}" ]]; then
      verify_args+=(--signature "${SIGNATURE}")
    fi
    python3 "${verifier}" "${verify_args[@]}"

    echo "Extracting bundle..."
    work_dir="$(mktemp -d "${TMPDIR:-/tmp}/rosdeck-ota.XXXXXX")"
    trap 'rm -rf -- "${work_dir}"' EXIT
    tar -xzf "${ARCHIVE}" -C "${work_dir}"
    bundle_dir=""
    for candidate_dir in "${work_dir}"/*/; do
      if [[ -f "${candidate_dir}manifest.env" ]]; then
        bundle_dir="${candidate_dir%/}"
        break
      fi
    done
    if [[ -z "${bundle_dir}" ]]; then
      rosdeck_core_die "archive does not contain a rosdeck bundle (manifest.env not found)"
    fi

    # New bundle metadata (trusted: the archive passed verification above).
    new_profile="" new_model="" new_arch="" new_distro=""
    {
      IFS= read -r new_profile || true
      IFS= read -r new_model || true
      IFS= read -r new_arch || true
      IFS= read -r new_distro || true
    } < <(. "${bundle_dir}/manifest.env" && printf '%s\n' \
      "${BUNDLE_PROFILE}" "${BUNDLE_ZSIBOT_MODEL:-}" "${BUNDLE_ARCH}" \
      "${BUNDLE_ROS_DISTRO}")
    case "${new_profile}" in
      vbot|zsibot) ;;
      *)
        rosdeck_core_die "bundle has unsupported profile: ${new_profile}" ;;
    esac

    # Profile/model must match the robot's current release: an archive built
    # for another robot type must never be installed here.
    current_profile="$(. "${INSTALL_PREFIX}/current/manifest.env" 2>/dev/null \
      && printf '%s' "${BUNDLE_PROFILE:-}" || true)"
    if [[ -n "${current_profile}" && "${current_profile}" != "${new_profile}" ]]; then
      rosdeck_core_die "profile mismatch: current release is ${current_profile}, bundle is ${new_profile}"
    fi
    if [[ "${new_profile}" == "zsibot" ]]; then
      case "${new_model}" in
        zsl-1|zsl-1w) ;;
        *)
          rosdeck_core_die "bundle has unsupported ZSI model: ${new_model}" ;;
      esac
      current_model="$(. "${INSTALL_PREFIX}/current/manifest.env" 2>/dev/null \
        && printf '%s' "${BUNDLE_ZSIBOT_MODEL:-}" || true)"
      if [[ -n "${current_model}" && "${current_model}" != "${new_model}" ]]; then
        rosdeck_core_die "model mismatch: current release is ${current_model}, bundle is ${new_model}"
      fi
    fi

    if [[ -z "${ENABLE_FOXGLOVE}" ]]; then
      if [[ "${new_profile}" == "zsibot" ]]; then
        ENABLE_FOXGLOVE=1
      else
        ENABLE_FOXGLOVE=0
      fi
    fi

    resolve_ros_setup
    node_name="$(node_name_for_profile "${new_profile}")"

    echo "Installing release into ${INSTALL_PREFIX}..."
    rosdeck_install_bundle "${bundle_dir}" "${INSTALL_PREFIX}" "${ROS_SETUP}" \
      "${new_profile}" "${new_arch}" "${new_distro}" "${node_name}" \
      "${ENABLE_FOXGLOVE}" "${KEEP}" "${ENABLE_SERVICE}"
    echo "OTA install complete."
    rosdeck_ab_status "${INSTALL_PREFIX}"
    ;;
esac