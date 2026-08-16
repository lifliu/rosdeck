#!/usr/bin/env bash
set -euo pipefail

# The caller must source the ROS and product overlays before invoking this
# probe.  It verifies that graph discovery is stable, that the discovered
# processes belong to this systemd unit, and (for ZsiBot) that live supervisor
# and arbiter status agree on a healthy E-stop monitor.

PROFILE="${1:?usage: assert-product-bringup-health.sh PROFILE GATEWAY_NODE [SERVICE]}"
GATEWAY_NODE="${2:?missing gateway node name}"
SERVICE_NAME="${3:-rosdeck-robot-bridge.service}"
SAFETY_NODE="/rosdeck_safety_supervisor"
STABLE_SAMPLES="${PRODUCT_HEALTH_STABLE_SAMPLES:-5}"
MAX_ATTEMPTS="${PRODUCT_HEALTH_MAX_ATTEMPTS:-20}"

if [[ ! "${PROFILE}" =~ ^(vbot|zsibot)$ ]]; then
  echo "ERROR: unsupported product health profile: ${PROFILE}" >&2
  exit 2
fi
for value in "${STABLE_SAMPLES}" "${MAX_ATTEMPTS}"; do
  if [[ ! "${value}" =~ ^[1-9][0-9]*$ ]]; then
    echo "ERROR: product health sample counts must be positive integers." >&2
    exit 2
  fi
done
if (( STABLE_SAMPLES > MAX_ATTEMPTS )); then
  echo "ERROR: stable sample count cannot exceed maximum attempts." >&2
  exit 2
fi

for command_name in systemctl systemd-cgls ros2 timeout; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "ERROR: required health-check command is unavailable: ${command_name}" >&2
    exit 5
  fi
done

main_pid="$(systemctl show --property=MainPID --value "${SERVICE_NAME}")"
control_group="$(systemctl show --property=ControlGroup --value "${SERVICE_NAME}")"
if [[ ! "${main_pid}" =~ ^[1-9][0-9]*$ || -z "${control_group}" || "${control_group}" == "/" ]]; then
  echo "ERROR: ${SERVICE_NAME} has no stable MainPID/control group." >&2
  exit 6
fi

stable=0
for (( attempt = 1; attempt <= MAX_ATTEMPTS; ++attempt )); do
  current_pid="$(systemctl show --property=MainPID --value "${SERVICE_NAME}")"
  graph="$(ros2 node list 2>/dev/null || true)"
  graph_ready=0
  if grep -Fxq "${GATEWAY_NODE}" <<< "${graph}"; then
    if [[ "${PROFILE}" == "vbot" ]] || grep -Fxq "${SAFETY_NODE}" <<< "${graph}"; then
      graph_ready=1
    fi
  fi
  if [[ "${current_pid}" == "${main_pid}" && "${graph_ready}" -eq 1 ]] &&
    systemctl is-active --quiet "${SERVICE_NAME}"
  then
    ((stable += 1))
  else
    stable=0
  fi
  if (( stable >= STABLE_SAMPLES )); then
    break
  fi
  sleep 1
done
if (( stable < STABLE_SAMPLES )); then
  echo "ERROR: product nodes did not remain simultaneously stable for ${STABLE_SAMPLES}s." >&2
  exit 7
fi

cgroup_listing="$(systemd-cgls --no-pager -l "${control_group}" 2>&1)" || {
  echo "ERROR: cannot inspect the service control group ${control_group}." >&2
  exit 8
}
if ! grep -Fq "rosdeck_robot_bridge_node" <<< "${cgroup_listing}"; then
  echo "ERROR: Gateway graph name is not backed by this service control group." >&2
  exit 8
fi
if [[ "${PROFILE}" == "zsibot" ]] &&
  ! grep -Fq "rosdeck_safety_supervisor_node" <<< "${cgroup_listing}"
then
  echo "ERROR: Safety Supervisor graph name is not backed by this service control group." >&2
  exit 8
fi

read_status_once()
{
  local topic="$1"
  local output
  if ! output="$(timeout 6 ros2 topic echo "${topic}" std_msgs/msg/String --once 2>/dev/null)"; then
    echo "ERROR: no live status received from ${topic}." >&2
    return 1
  fi
  printf '%s\n' "${output}"
}

if [[ "${PROFILE}" == "zsibot" ]]; then
  supervisor_first="$(read_status_once /omni/safety/supervisor_status)"
  if ! grep -Fq "heartbeat_fresh=true" <<< "${supervisor_first}" ||
    ! grep -Fq "output_estop=" <<< "${supervisor_first}"
  then
    echo "ERROR: Safety Supervisor status is malformed or stale." >&2
    exit 9
  fi
  sequence_first="$(sed -n 's/.*heartbeat_seq=\([0-9][0-9]*\).*/\1/p' <<< "${supervisor_first}" | head -1)"
  sleep 1
  supervisor_second="$(read_status_once /omni/safety/supervisor_status)"
  sequence_second="$(sed -n 's/.*heartbeat_seq=\([0-9][0-9]*\).*/\1/p' <<< "${supervisor_second}" | head -1)"
  if [[ ! "${sequence_first}" =~ ^[0-9]+$ || ! "${sequence_second}" =~ ^[0-9]+$ ]] ||
    (( sequence_second <= sequence_first ))
  then
    echo "ERROR: Safety Supervisor heartbeat sequence is not advancing." >&2
    exit 9
  fi

  arbiter_status="$(read_status_once /omni/cmd_vel/arbiter_status)"
  if ! grep -Fq "estop=" <<< "${arbiter_status}" ||
    ! grep -Fq "estop_monitor_fault=false" <<< "${arbiter_status}"
  then
    echo "ERROR: Gateway does not report a healthy E-stop monitor." >&2
    exit 9
  fi
fi

final_pid="$(systemctl show --property=MainPID --value "${SERVICE_NAME}")"
if [[ "${final_pid}" != "${main_pid}" ]] || ! systemctl is-active --quiet "${SERVICE_NAME}"; then
  echo "ERROR: product service restarted during its health check." >&2
  exit 10
fi

echo "Product bringup healthy: profile=${PROFILE} gateway=${GATEWAY_NODE} pid=${main_pid}"
