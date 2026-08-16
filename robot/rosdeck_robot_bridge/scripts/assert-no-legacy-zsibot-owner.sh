#!/usr/bin/env bash
set -euo pipefail

# Product startup must reject old SDK owners, including binaries left behind in
# a reused colcon prefix. The flock is still required for races after this
# preflight; this guard also catches pre-lock legacy builds by process name.

CHECK_PROCESSES=1
CHECK_ARTIFACTS=1
case "${1:-}" in
  --processes-only)
    CHECK_ARTIFACTS=0
    shift
    ;;
  --artifacts-only)
    CHECK_PROCESSES=0
    shift
    ;;
esac

if [[ "${CHECK_PROCESSES}" -eq 1 ]]; then
  if ! command -v pgrep >/dev/null 2>&1; then
    echo "ERROR: pgrep is unavailable; cannot prove that no legacy SDK owner is running." >&2
    exit 5
  fi

  set +e
  process_check_output="$({ pgrep -f \
    '(^|/)(zsibot_cmd_bridge|zsibot_sdk_proxy)([[:space:]]|$)'; } 2>&1)"
  process_check_status=$?
  set -e
  case "${process_check_status}" in
    0)
      echo "ERROR: a deprecated ZsiBot SDK-owner process is still running." >&2
      echo "       PID(s): ${process_check_output}" >&2
      echo "       Stop zsibot_cmd_bridge/zsibot_sdk_proxy before product startup." >&2
      exit 4
      ;;
    1)
      ;;
    *)
      echo "ERROR: process enumeration failed; refusing product startup." >&2
      echo "       pgrep: ${process_check_output}" >&2
      exit 5
      ;;
  esac
fi

if [[ "${CHECK_ARTIFACTS}" -eq 0 ]]; then
  exit 0
fi

install_prefixes=("$@")
if [[ ${#install_prefixes[@]} -eq 0 && -n "${AMENT_PREFIX_PATH:-}" ]]; then
  IFS=':' read -r -a install_prefixes <<< "${AMENT_PREFIX_PATH}"
fi

for install_prefix in "${install_prefixes[@]}"; do
  [[ -n "${install_prefix}" ]] || continue
  for stale_target in \
    "${install_prefix}/lib/zsibot_cmd_bridge/zsibot_cmd_bridge" \
    "${install_prefix}/lib/zsibot_cmd_bridge/zsibot_sdk_proxy"
  do
    if [[ -e "${stale_target}" || -L "${stale_target}" ]]; then
      echo "ERROR: stale deprecated SDK-owner binary remains in an active install tree:" >&2
      echo "       ${stale_target}" >&2
      echo "       Build/deploy into a clean product install prefix before startup." >&2
      exit 3
    fi
  done
done
