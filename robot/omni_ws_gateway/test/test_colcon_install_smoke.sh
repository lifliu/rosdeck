#!/usr/bin/env bash
set -euo pipefail

PACKAGE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/omni-ws-gateway-colcon.XXXXXX")"
trap 'rm -rf -- "${WORK_ROOT}"' EXIT

if [[ -f /opt/ros/humble/setup.bash ]]; then
  set +u
  source /opt/ros/humble/setup.bash
  set -u
fi
command -v colcon >/dev/null 2>&1 || {
  echo "colcon is required for the omni_ws_gateway install smoke" >&2
  exit 1
}
command -v ros2 >/dev/null 2>&1 || {
  echo "ros2 is required for the omni_ws_gateway install smoke" >&2
  exit 1
}

install -d "${WORK_ROOT}/src"
ln -s "${PACKAGE_DIR}" "${WORK_ROOT}/src/omni_ws_gateway"
colcon --log-base "${WORK_ROOT}/log" build \
  --base-paths "${WORK_ROOT}/src" \
  --build-base "${WORK_ROOT}/build" \
  --install-base "${WORK_ROOT}/install" \
  --merge-install \
  --packages-select omni_ws_gateway \
  --event-handlers console_direct+

set +u
source "${WORK_ROOT}/install/local_setup.bash"
set -u

for executable in omni-ws-gateway omni-auth; do
  installed="${WORK_ROOT}/install/lib/omni_ws_gateway/${executable}"
  if [[ ! -x "${installed}" ]]; then
    echo "missing ROS package executable: ${installed}" >&2
    exit 1
  fi
  ros2 pkg executables omni_ws_gateway \
    | grep -Fxq "omni_ws_gateway ${executable}"
done

# Exercise both console-script entry points through ros2 run. The gateway is
# given an intentionally invalid endpoint so it imports, parses configuration,
# and exits immediately without opening sockets or requiring TLS material.
ros2 run omni_ws_gateway omni-auth --help >/dev/null
set +e
gateway_output="$(OMNI_WS_LISTEN=invalid \
  ros2 run omni_ws_gateway omni-ws-gateway 2>&1)"
gateway_status=$?
set -e
if [[ "${gateway_status}" -ne 2 ]] \
  || ! grep -Fq "invalid host:port value" <<< "${gateway_output}"; then
  echo "omni-ws-gateway ros2 run smoke failed (status=${gateway_status})" >&2
  echo "${gateway_output}" >&2
  exit 1
fi

echo "test_colcon_install_smoke: all passed"
