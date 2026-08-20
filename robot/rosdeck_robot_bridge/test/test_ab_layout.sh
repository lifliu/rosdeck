#!/usr/bin/env bash
# Tests for the pure (filesystem-only) A/B release state machine in
# scripts/deploy-core.sh: release ids, slot staging, current/previous
# switching, rollback, pruning, status, legacy adoption.
#
# No root, systemd, ROS, or network needed. Deliberately bash-3.2 compatible
# (no mapfile/realpath) so it also runs on the build host's default shell:
#   bash robot/rosdeck_robot_bridge/test/test_ab_layout.sh
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../scripts/deploy-core.sh
source "${HERE}/../scripts/deploy-core.sh"

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/rosdeck-ab-test.XXXXXX")"
trap 'rm -rf -- "${ROOT}"' EXIT

PREFIX="${ROOT}/prefix"
install -d "${PREFIX}"

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
assert_file() {
  if [[ ! -f "$1" ]]; then
    fail "expected file: $1"
  fi
}
assert_dir() {
  if [[ ! -d "$1" ]]; then
    fail "expected directory: $1"
  fi
}
assert_not_dir() {
  if [[ -d "$1" ]]; then
    fail "directory should not exist: $1"
  fi
}
assert_not_file() {
  if [[ -f "$1" ]]; then
    fail "file should not exist: $1"
  fi
}
assert_link() {
  if [[ ! -L "$1" ]]; then
    fail "expected symlink: $1"
  fi
}
assert_not_link() {
  if [[ -L "$1" ]]; then
    fail "symlink should not exist: $1"
  fi
}
assert_exec() {
  if [[ ! -x "$1" ]]; then
    fail "expected executable: $1"
  fi
}
assert_contains() {
  # $1 haystack, $2 needle, $3 label
  case "$1" in
    *"$2"*) ;;
    *) fail "$3: [$1] does not contain [$2]" ;;
  esac
}

make_bundle() {
  # $1 dir, $2 version, $3 source epoch, $4 model (optional)
  local dir="$1" version="$2" epoch="$3" model="${4:-}"
  install -d "${dir}/bin" "${dir}/config" "${dir}/runtime/lib" \
    "${dir}/templates" "${dir}/tools"
  printf '#!/bin/sh\nexit 0\n' > "${dir}/bin/rosdeck_robot_bridge_node"
  chmod 0755 "${dir}/bin/rosdeck_robot_bridge_node"
  printf 'node: {}\n' > "${dir}/config/bridge.yaml"
  printf '# verifier placeholder\n' > "${dir}/tools/release_artifacts.py"
  python3 - "${dir}/release-manifest.json" "${version}" "${model}" "${epoch}" <<'PY'
import json
import sys

path, version, model, epoch = sys.argv[1:5]
with open(path, "w", encoding="utf-8") as handle:
    json.dump({"version": version, "model": model or None,
               "source_epoch": int(epoch)}, handle)
PY
}

# --- release id ---------------------------------------------------------------
B1="${ROOT}/bundle-1.0.0"
make_bundle "${B1}" "1.0.0" "1000"
assert_eq "$(rosdeck_ab_release_id "${B1}")" "1.0.0-1000" "release id (no model)"

B_MODEL="${ROOT}/bundle-model"
make_bundle "${B_MODEL}" "1.0.0" "1000" "zsl-1"
assert_eq "$(rosdeck_ab_release_id "${B_MODEL}")" "1.0.0-zsl-1-1000" "release id (with model)"

LEGACY="${ROOT}/bundle-legacy"
install -d "${LEGACY}/bin"
printf 'BUNDLE_VERSION=0.9.0\nBUNDLE_PROFILE=vbot\n' > "${LEGACY}/manifest.env"
legacy_id="$(rosdeck_ab_release_id "${LEGACY}")"
case "${legacy_id}" in
  legacy-0.9.0-*) ;;
  *) fail "legacy release id: expected legacy-0.9.0-*, got [${legacy_id}]" ;;
esac

# --- stage / activate / rollback ------------------------------------------------
rosdeck_ab_stage "${B1}" "${PREFIX}" "1.0.0-1000"
assert_file "${PREFIX}/releases/1.0.0-1000/release-manifest.json" "staged manifest"
assert_file "${PREFIX}/releases/1.0.0-1000/config/bridge.yaml" "staged config"

rosdeck_ab_activate "${PREFIX}" "1.0.0-1000" 3
assert_eq "$(rosdeck_ab_active_id "${PREFIX}")" "1.0.0-1000" "first current"
assert_link "${PREFIX}/current" "current is a symlink"
assert_not_link "${PREFIX}/previous" "no previous on first install"
assert_exec "${PREFIX}/current/bin/rosdeck_robot_bridge_node" "current resolves to node binary"

B2="${ROOT}/bundle-1.0.1"
make_bundle "${B2}" "1.0.1" "2000"
rosdeck_ab_stage "${B2}" "${PREFIX}" "1.0.1-2000"
rosdeck_ab_activate "${PREFIX}" "1.0.1-2000" 3
assert_eq "$(rosdeck_ab_active_id "${PREFIX}")" "1.0.1-2000" "current after upgrade"
assert_eq "$(basename "$(readlink "${PREFIX}/previous")")" "1.0.0-1000" "previous after upgrade"

rosdeck_ab_rollback "${PREFIX}"
assert_eq "$(rosdeck_ab_active_id "${PREFIX}")" "1.0.0-1000" "current after rollback"
assert_eq "$(basename "$(readlink "${PREFIX}/previous")")" "1.0.1-2000" "previous after rollback"
rosdeck_ab_rollback "${PREFIX}"
assert_eq "$(rosdeck_ab_active_id "${PREFIX}")" "1.0.1-2000" "current after double rollback"

# --- prune ------------------------------------------------------------------------
B3="${ROOT}/bundle-2.0.0"
make_bundle "${B3}" "2.0.0" "3000"
B4="${ROOT}/bundle-2.0.1"
make_bundle "${B4}" "2.0.1" "4000"
B5="${ROOT}/bundle-2.0.2"
make_bundle "${B5}" "2.0.2" "5000"
for entry in "2.0.0-3000:${B3}" "2.0.1-4000:${B4}" "2.0.2-5000:${B5}"; do
  next_id="${entry%%:*}"
  next_src="${entry#*:}"
  rosdeck_ab_stage "${next_src}" "${PREFIX}" "${next_id}"
  rosdeck_ab_activate "${PREFIX}" "${next_id}" 3
done
slot_count=0
for slot in "${PREFIX}"/releases/*/; do
  if [[ -d "${slot}" ]]; then
    slot_count=$((slot_count + 1))
  fi
done
assert_eq "${slot_count}" "3" "slot count after prune (keep=3)"
assert_eq "$(rosdeck_ab_active_id "${PREFIX}")" "2.0.2-5000" "current after prune"
assert_dir "${PREFIX}/releases/2.0.2-5000" "current slot retained"
assert_dir "${PREFIX}/releases/2.0.1-4000" "previous slot retained"
assert_dir "${PREFIX}/releases/2.0.0-3000" "newest old slot retained"
assert_not_dir "${PREFIX}/releases/1.0.1-2000" "older slot pruned"
assert_not_dir "${PREFIX}/releases/1.0.0-1000" "oldest slot pruned"

# --- status --------------------------------------------------------------------------
status_out="$(rosdeck_ab_status "${PREFIX}")"
assert_contains "${status_out}" "current:  2.0.2-5000" "status current line"
assert_contains "${status_out}" "previous: 2.0.1-4000" "status previous line"
assert_contains "${status_out}" "version=2.0.2 model=- source_epoch=5000" "status slot detail"

# --- failure paths (subshells so die() cannot take the test down) ---------------------
FRESH="${ROOT}/fresh-prefix"
install -d "${FRESH}"
rosdeck_ab_stage "${B1}" "${FRESH}" "1.0.0-1000"
rosdeck_ab_activate "${FRESH}" "1.0.0-1000" 3

if (rosdeck_ab_rollback "${FRESH}") >/dev/null 2>&1; then
  fail "rollback without a previous release should fail"
fi
if (rosdeck_ab_activate "${FRESH}" "9.9.9-1") >/dev/null 2>&1; then
  fail "activating a missing slot should fail"
fi
if (rosdeck_ab_stage "${B1}" "${FRESH}" "1.0.0-1000") >/dev/null 2>&1; then
  fail "re-staging an existing slot should fail"
fi
if (rosdeck_ab_stage "${B1}" "${FRESH}" "../evil") >/dev/null 2>&1; then
  fail "unsafe (relative) release id should be rejected"
fi
if (rosdeck_ab_stage "${B1}" "${FRESH}" "/abs") >/dev/null 2>&1; then
  fail "unsafe (absolute) release id should be rejected"
fi

# --- legacy adoption --------------------------------------------------------------------
LEGACY_PREFIX="${ROOT}/legacy-prefix"
install -d "${LEGACY_PREFIX}/bin" "${LEGACY_PREFIX}/config" "${LEGACY_PREFIX}/runtime"
printf 'old runtime marker\n' > "${LEGACY_PREFIX}/runtime/local_setup.bash"
printf '#!/bin/sh\nexit 0\n' > "${LEGACY_PREFIX}/bin/rosdeck_robot_bridge_node"
printf 'operator: tuned\n' > "${LEGACY_PREFIX}/config/bridge.yaml"
rosdeck_ab_adopt_legacy "${LEGACY_PREFIX}" "${B1}"
legacy_slots=0
for slot in "${LEGACY_PREFIX}"/releases/*/; do
  if [[ -d "${slot}" ]]; then
    legacy_slots=$((legacy_slots + 1))
  fi
done
assert_eq "${legacy_slots}" "1" "legacy adoption creates exactly one slot"
assert_not_dir "${LEGACY_PREFIX}/runtime" "legacy runtime moved into slot"
assert_not_file "${LEGACY_PREFIX}/bin/rosdeck_robot_bridge_node" "legacy node binary moved into slot"
assert_link "${LEGACY_PREFIX}/previous" "legacy slot registered as previous"
legacy_slot_name="$(basename "$(readlink "${LEGACY_PREFIX}/previous")")"
case "${legacy_slot_name}" in
  legacy-*) ;;
  *) fail "legacy slot name: expected legacy-*, got [${legacy_slot_name}]" ;;
esac
assert_file "${LEGACY_PREFIX}/releases/${legacy_slot_name}/runtime/local_setup.bash" "slot has legacy runtime"
assert_file "${LEGACY_PREFIX}/releases/${legacy_slot_name}/config/bridge.yaml" "slot has legacy config"
assert_file "${LEGACY_PREFIX}/releases/${legacy_slot_name}/tools/release_artifacts.py" "slot gained modern verifier"

# --- no-op legacy adoption on a fresh prefix -----------------------------------------------
CLEAN="${ROOT}/clean-prefix"
install -d "${CLEAN}"
rosdeck_ab_adopt_legacy "${CLEAN}" "${B1}"
assert_not_dir "${CLEAN}/releases" "fresh prefix has no slots after adoption"

# -------------------------------------------------------------------------------------------
if [[ "${FAILED}" -ne 0 ]]; then
  echo "test_ab_layout: FAILED" >&2
  exit 1
fi
echo "test_ab_layout: all passed"