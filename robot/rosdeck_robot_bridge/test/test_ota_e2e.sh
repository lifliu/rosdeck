#!/usr/bin/env bash
# Offline end-to-end test of the OTA front end (scripts/ota.sh) and the
# release orchestrator (scripts/deploy-core.sh): archive verification ->
# extraction -> profile/model gates -> slot staging -> atomic `current`
# switch -> service apply -> bringup health check -> automatic rollback ->
# manual rollback -> no-op reinstall -> pruning.
#
# No root, systemd, ROS, or network needed: `ros2`/`systemctl`/`journalctl`
# and `timeout` are stubbed on PATH, the /etc, /run and /userdata write
# targets are redirected into a temp tree via the ROSDECK_* overrides, and
# every bundle is a REAL verifiable archive produced by the shipped
# release_artifacts.py (deterministic tar + sha256 sidecar + manifest).
#
#   bash robot/rosdeck_robot_bridge/test/test_ota_e2e.sh
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="${HERE}/../scripts"
# shellcheck source=../scripts/deploy-core.sh
source "${SCRIPTS}/deploy-core.sh"

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/rosdeck-ota-e2e.XXXXXX")"
trap 'rm -rf -- "${ROOT}"' EXIT

FAILED=0
fail() {
  echo "FAIL: $*" >&2
  FAILED=1
}
assert_eq() {
  # $1 actual, $2 expected, $3 label
  if [[ "$1" != "$2" ]]; then
    fail "${3}: expected [$2], got [$1]"
  fi
}
assert_dir() {
  if [[ ! -d "$1" ]]; then
    fail "expected directory: $1"
  fi
}
assert_file() {
  if [[ ! -f "$1" ]]; then
    fail "expected file: $1"
  fi
}
assert_not_dir() {
  if [[ -d "$1" ]]; then
    fail "directory should not exist: $1"
  fi
}
assert_link() {
  if [[ ! -L "$1" ]]; then
    fail "expected symlink: $1"
  fi
}
assert_contains() {
  # $1 haystack, $2 needle, $3 label
  case "$1" in
    *"$2"*) ;;
    *) fail "$3: [$1] does not contain [$2]" ;;
  esac
}
assert_not_contains() {
  # $1 haystack, $2 needle, $3 label
  case "$1" in
    *"$2"*) fail "$3: [$1] should not contain [$2]" ;;
    *) ;;
  esac
}

# --- stub commands ------------------------------------------------------------
STUB_BIN="${ROOT}/stub-bin"
install -d "${STUB_BIN}"
printf '%s\n' '#!/bin/sh' 'exit 0' > "${STUB_BIN}/ros2"
printf '%s\n' '#!/bin/sh' 'exit 0' > "${STUB_BIN}/systemctl"
printf '%s\n' '#!/bin/sh' 'exit 0' > "${STUB_BIN}/journalctl"
# The health check invokes `timeout 50 bash -c ...`; the stub drops the
# duration and execs the rest so the real script body runs.
printf '%s\n' '#!/bin/sh' 'shift' 'exec "$@"' > "${STUB_BIN}/timeout"
# ldd exists on the robot (Linux) but not on macOS; the check only looks
# for a "not found" line, so a clean stub is enough.
printf '%s\n' '#!/bin/sh' 'exit 0' > "${STUB_BIN}/ldd"
chmod 0755 "${STUB_BIN}/ros2" "${STUB_BIN}/systemctl" \
  "${STUB_BIN}/journalctl" "${STUB_BIN}/timeout" "${STUB_BIN}/ldd"

# Redirected write targets + non-root allowance (test-only, see ota.sh).
ETC="${ROOT}/etc"
RUN="${ROOT}/run"
USERDATA="${ROOT}/userdata"
export ROSDECK_ETC_ROOT="${ETC}" ROSDECK_RUN_ROOT="${RUN}" \
  ROSDECK_USERDATA_DIR="${USERDATA}" ROSDECK_OTA_ALLOW_NONROOT=1

PREFIX="${ROOT}/prefix"
install -d "${PREFIX}"

ROS_SETUP="${ROOT}/ros_setup.sh"
cat > "${ROS_SETUP}" <<'EOF'
export ROS_DISTRO=humble
export RMW_IMPLEMENTATION=rmw_zenoh_cpp
export ROS_DOMAIN_ID=0
export ROS_LOCALHOST_ONLY=0
EOF

run_ota() {
  env PATH="${STUB_BIN}:${PATH}" bash "${SCRIPTS}/ota.sh" "$@"
}
# OUT holds the captured output of the last expect_ok/expect_fail call.
OUT=""
expect_ok() {
  # $1 label, remaining args: ota.sh command
  local label="$1"
  shift
  if ! OUT="$(run_ota "$@" 2>&1)"; then
    echo "--- ${label}: ota.sh output ---" >&2
    echo "${OUT}" >&2
    echo "test_ota_e2e: FAILED (${label})" >&2
    exit 1
  fi
}
expect_fail() {
  local label="$1"
  shift
  if OUT="$(run_ota "$@" 2>&1)"; then
    fail "${label}: expected a non-zero exit, got 0"
  fi
}

# --- bundle factory ---------------------------------------------------------
# make_bundle <version> <epoch> <healthy: 0|1> [profile] [model]
# Stages a full bundle (node, runtime, templates, tooling, manifest.env) and
# runs the real release_artifacts.py to produce a verifiable archive.
make_bundle() {
  local version="$1" epoch="$2" healthy="$3"
  local profile="${4:-vbot}" model="${5:-}"
  local name="rosdeck-robot-bridge-${version}"
  # release_artifacts.py requires the stage directory to be named after the
  # bundle (it is the archive's top-level directory).
  local stage="${ROOT}/stages/${name}"
  install -d "${stage}/bin" "${stage}/config" "${stage}/templates" \
    "${stage}/runtime/lib/rosdeck_robot_bridge" "${stage}/tools" \
    "${stage}/lib"
  printf '%s\n' '#!/bin/sh' 'exit 0' > "${stage}/bin/rosdeck_robot_bridge_node"
  printf '%s\n' 'node: {}' > "${stage}/config/bridge.yaml"
  printf '%s\n' 'echo "@CURRENT@ @NODE_NAME@ @PROFILE@ @ROS_SETUP@ @INSTALL_PREFIX@"' \
    > "${stage}/templates/run-bridge.in"
  printf '%s\n' 'echo "@INSTALL_PREFIX@"' > "${stage}/templates/bootstrap-service.in"
  printf '%s\n' 'ExecStart=@INSTALL_PREFIX@/bin/run-rosdeck-robot-bridge' \
    > "${stage}/templates/rosdeck-robot-bridge.service.in"
  printf '%s\n' '# offline test runtime' > "${stage}/runtime/local_setup.bash"
  printf '%s\n' '#!/bin/sh' 'exit 0' \
    > "${stage}/runtime/lib/rosdeck_robot_bridge/rosdeck_robot_bridge_node"
  printf '%s\n' '#!/bin/sh' 'exit 0' \
    > "${stage}/runtime/lib/rosdeck_robot_bridge/rosdeck_safety_supervisor_node"
  if [[ "${healthy}" -eq 1 ]]; then
    printf '%s\n' '#!/bin/sh' 'exit 0' \
      > "${stage}/runtime/lib/rosdeck_robot_bridge/assert-product-bringup-health.sh"
  else
    printf '%s\n' '#!/bin/sh' 'echo "simulated bringup failure" >&2' 'exit 1' \
      > "${stage}/runtime/lib/rosdeck_robot_bridge/assert-product-bringup-health.sh"
  fi
  chmod 0755 "${stage}/bin/rosdeck_robot_bridge_node" \
    "${stage}/runtime/lib/rosdeck_robot_bridge/"*
  install -m 0644 "${SCRIPTS}/release_artifacts.py" \
    "${stage}/tools/release_artifacts.py"
  install -m 0644 "${SCRIPTS}/deploy-core.sh" "${stage}/lib/deploy-core.sh"
  install -m 0755 "${SCRIPTS}/ota.sh" "${stage}/ota.sh"
  cat > "${stage}/manifest.env" <<EOF
BUNDLE_VERSION=${version}
BUNDLE_PROFILE=${profile}
BUNDLE_ZSIBOT_MODEL=${model}
BUNDLE_ARCH=$(uname -m)
BUNDLE_ROS_DISTRO=humble
EOF
  install -d "${ROOT}/out"
  local model_args=()
  if [[ -n "${model}" ]]; then
    model_args=(--model "${model}")
  fi
  # ${model_args[@]+...}: expanding an empty array under set -u is an
  # error on bash 3.2.
  python3 "${SCRIPTS}/release_artifacts.py" facts \
    --stage "${stage}" --bundle-name "${name}" --version "${version}" \
    --profile "${profile}" ${model_args[@]+"${model_args[@]}"} \
    --arch "$(uname -m)" \
    --distro humble --epoch "${epoch}" --epoch-origin env \
    --output "${ROOT}/facts-${version}.json"
  python3 "${SCRIPTS}/release_artifacts.py" make \
    --facts "${ROOT}/facts-${version}.json" --output-dir "${ROOT}/out"
}

# --- baseline: a modern release already deployed (the first deploy.sh run) ---
make_bundle 1.0.0 1000 1
rosdeck_ab_stage "${ROOT}/stages/rosdeck-robot-bridge-1.0.0" "${PREFIX}" "1.0.0-1000"
rosdeck_ab_activate "${PREFIX}" "1.0.0-1000" 3
assert_link "${PREFIX}/current" "baseline current symlink"

# --- OTA upgrade: 2.0.0 (healthy) ---------------------------------------------
make_bundle 2.0.0 2000 1
expect_ok "install 2.0.0" install \
  "${ROOT}/out/rosdeck-robot-bridge-2.0.0.tar.gz" \
  --prefix "${PREFIX}" --ros-setup "${ROS_SETUP}"
assert_contains "${OUT}" "OTA install complete." "install banner"
assert_eq "$(rosdeck_ab_active_id "${PREFIX}")" "2.0.0-2000" "current after upgrade"
assert_eq "$(basename "$(readlink "${PREFIX}/previous")")" "1.0.0-1000" \
  "previous after upgrade"
assert_file "${PREFIX}/bin/ota.sh" "ota.sh refreshed into prefix/bin"
assert_file "${PREFIX}/lib/deploy-core.sh" "core library refreshed into prefix/lib"
assert_contains "$(cat "${PREFIX}/bin/run-rosdeck-robot-bridge")" \
  "${PREFIX}/current" "glue renders the current path"
assert_file "${ETC}/systemd/system/rosdeck-robot-bridge.service" \
  "unit installed under etc root"
assert_file "${RUN}/systemd/system/rosdeck-robot-bridge.service" \
  "unit installed under run root"
assert_contains "$(cat "${USERDATA}/startup.sh")" \
  "# ROSDECK ROBOT BRIDGE" "boot autostart hook registered"
assert_contains "$(cat "${PREFIX}/config/bridge.env")" \
  "ROS_DOMAIN_ID=0" "bridge.env prepared"

# --- no-op reinstall: same id = same content ---------------------------------
expect_ok "reinstall 2.0.0" install \
  "${ROOT}/out/rosdeck-robot-bridge-2.0.0.tar.gz" \
  --prefix "${PREFIX}" --ros-setup "${ROS_SETUP}"
assert_contains "${OUT}" "already active" "no-op detected"
assert_eq "$(rosdeck_ab_active_id "${PREFIX}")" "2.0.0-2000" \
  "current unchanged on no-op"
assert_eq "$(basename "$(readlink "${PREFIX}/previous")")" "1.0.0-1000" \
  "previous unchanged on no-op"

# --- manual rollback ----------------------------------------------------------
expect_ok "manual rollback" rollback --prefix "${PREFIX}" \
  --ros-setup "${ROS_SETUP}"
assert_eq "$(rosdeck_ab_active_id "${PREFIX}")" "1.0.0-1000" \
  "current after manual rollback"
assert_eq "$(basename "$(readlink "${PREFIX}/previous")")" "2.0.0-2000" \
  "previous after manual rollback"

# --- restore 2.0.0, then upgrade to a BROKEN release --------------------------
expect_ok "reinstall 2.0.0 (restore)" install \
  "${ROOT}/out/rosdeck-robot-bridge-2.0.0.tar.gz" \
  --prefix "${PREFIX}" --ros-setup "${ROS_SETUP}"
assert_eq "$(rosdeck_ab_active_id "${PREFIX}")" "2.0.0-2000" "restored current"

make_bundle 2.0.1 2001 0
expect_fail "install 2.0.1 (broken)" install \
  "${ROOT}/out/rosdeck-robot-bridge-2.0.1.tar.gz" \
  --prefix "${PREFIX}" --ros-setup "${ROS_SETUP}"
assert_contains "${OUT}" "Rollback succeeded" "auto-rollback reported"
assert_not_contains "${OUT}" "OTA install complete." "no success banner"
assert_eq "$(rosdeck_ab_active_id "${PREFIX}")" "2.0.0-2000" \
  "current restored after auto-rollback"
assert_eq "$(basename "$(readlink "${PREFIX}/previous")")" "2.0.1-2001" \
  "broken release kept as previous"

# --- profile gate: a zsibot bundle must not install onto a vbot robot --------
make_bundle 3.0.0 3000 1 zsibot zsl-1
expect_fail "profile mismatch" install \
  "${ROOT}/out/rosdeck-robot-bridge-3.0.0.tar.gz" \
  --prefix "${PREFIX}" --ros-setup "${ROS_SETUP}"
assert_contains "${OUT}" "profile mismatch" "mismatch message"
assert_eq "$(rosdeck_ab_active_id "${PREFIX}")" "2.0.0-2000" \
  "current unchanged after rejected profile"

# --- tamper detection: the verifier must reject a corrupted archive ----------
# The sidecar travels with the archive; corrupting the payload after signing
# must fail the sha256 check before anything is extracted.
cp "${ROOT}/out/rosdeck-robot-bridge-2.0.1.tar.gz" "${ROOT}/out/tampered.tar.gz"
cp "${ROOT}/out/rosdeck-robot-bridge-2.0.1.tar.gz.sha256" \
  "${ROOT}/out/tampered.tar.gz.sha256"
printf 'x' >> "${ROOT}/out/tampered.tar.gz"
expect_fail "tampered archive" install "${ROOT}/out/tampered.tar.gz" \
  --prefix "${PREFIX}" --ros-setup "${ROS_SETUP}"
assert_contains "${OUT}" "verification FAILED" "verifier rejected the archive"
assert_not_contains "${OUT}" "Release:" "install never reached staging"
assert_eq "$(rosdeck_ab_active_id "${PREFIX}")" "2.0.0-2000" \
  "current unchanged after tampered archive"

# --- prune: keep=3 total slots -------------------------------------------------
make_bundle 2.0.2 2002 1
expect_ok "install 2.0.2" install \
  "${ROOT}/out/rosdeck-robot-bridge-2.0.2.tar.gz" \
  --prefix "${PREFIX}" --ros-setup "${ROS_SETUP}"
assert_eq "$(rosdeck_ab_active_id "${PREFIX}")" "2.0.2-2002" "current after 2.0.2"
assert_dir "${PREFIX}/releases/2.0.2-2002" "current slot retained"
assert_dir "${PREFIX}/releases/2.0.1-2001" "previous slot retained"
assert_dir "${PREFIX}/releases/2.0.0-2000" "newest old slot retained"
assert_not_dir "${PREFIX}/releases/1.0.0-1000" "oldest slot pruned (keep=3)"

# --- --no-start: switch without touching the service ---------------------------
make_bundle 2.0.3 2003 1
expect_ok "install 2.0.3 --no-start" install \
  "${ROOT}/out/rosdeck-robot-bridge-2.0.3.tar.gz" \
  --prefix "${PREFIX}" --ros-setup "${ROS_SETUP}" --no-start
assert_contains "${OUT}" "without starting the service" "no-start banner"
assert_eq "$(rosdeck_ab_active_id "${PREFIX}")" "2.0.3-2003" \
  "current after no-start install"

# --- status ---------------------------------------------------------------------
OUT="$(run_ota status --prefix "${PREFIX}")" \
  || fail "ota status"
assert_contains "${OUT}" "current:  2.0.3-2003" "status current line"
assert_contains "${OUT}" "previous: 2.0.2-2002" "status previous line"

# --------------------------------------------------------------------------------
if [[ "${FAILED}" -ne 0 ]]; then
  echo "test_ota_e2e: FAILED" >&2
  exit 1
fi
echo "test_ota_e2e: all passed"