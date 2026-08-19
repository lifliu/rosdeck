# omni_docking

Charging-dock controller for the omni inspection robot (Phase 3). Serves
the V1 docking contract from `omni_robot_interfaces`:

| Interface | Name |
|---|---|
| Action | `/omni/docking/dock` (`Dock`) — servo onto the dock, confirm charge |
| Action | `/omni/docking/undock` (`Undock`) — back off the dock along the axis |
| Service | `/omni/docking/verify_charge` (`VerifyCharge`) — BMS charge verdict now |
| Service | `/omni/docking/config` (`GetDockConfig`) — resolve the dock for a map |
| Topic out | `/omni/docking/status` (`DockStatus`, transient_local, 1 Hz) |
| Topic out | `/omni/cmd_vel/docking` (`geometry_msgs/Twist`, 20 Hz while an op is active) |
| Topic in | `/omni/robot_state`, `<pose_topic>` (`/state_estimation_global`), `/battery_state`, `/rosdeck/control_status` |

The mission manager's `ReturnToDock` chain (Phase 3 follow-up) reuses
this package: the global approach leg runs under the MISSION lease
(FollowRoute on the planner), the final-approach leg hands off to the
`Dock` action here, which self-owns the DOCKING lease.

## Control authority

The arbiter routes `/omni/cmd_vel/docking` only while the **DOCKING**
owner holds the lease, so this package acquires the lease with client id
`docking-<request_id>` (the request id is the idempotency key the App /
manager sends) and heartbeats it at 1 Hz until release. It uses the
gateway's Phase-0 **string protocol** on
`/rosdeck/control_command` / `/rosdeck/control_status`
(`"acquire|heartbeat|release:<client_id>"`, status
`"acquired:<client_id>"`) — see
`rosdeck_robot_bridge/doc/product_bringup_and_docking.md` §4.

> **Note:** the typed `ControlAuthority` service declared in
> `omni_robot_interfaces` currently has **no provider** in this
> repository (the gateway lease lives inside `zsibot_adapter`, reached
> only through the string topics). This package therefore speaks the
> string protocol; once a typed facade lands on the gateway,
> `omni_docking/authority.py` is the single swap point.

## Dock configuration

One JSON file per map in `docks_dir` (default `/var/lib/omni/docks`):

```json
{
  "schema_version": 1,
  "map_id": "floor1",
  "map_version": "",
  "dock_id": "dock-a",
  "pose": [3.2, -1.1, 1.57],
  "approach_distance": 0.6
}
```

- `pose` is the robot's **final docked pose** in the map frame
  (`lio_map`); `yaw` is the heading the robot faces when docked, i.e.
  **facing the dock face**. The robot arrives from behind (the `−yaw`
  side) and drives forward onto the dock.
- `approach_distance` is how far behind the dock pose the robot parks
  before the final approach (the standoff point).
- `map_version: ""` serves any version of the map; a specific string
  pins the entry to that map version.
- V1: at most one dock per map. A malformed file is **fail-closed**:
  the map simply has no dock (`REASON_DOCK_NOT_FOUND`), and the error is
  logged / reported via `GetDockConfig`.

Capture a dock pose on the robot (with the robot manually placed on the
dock, facing the dock face):

```bash
ros2 topic echo /state_estimation_global --once
# x = pose.pose.position.x, y = pose.pose.position.y
# yaw = atan2(2(w*x + y*z), 1 - 2(y^2 + z^2)) of pose.pose.orientation
```

## Behavior

Op lifecycle: `gate -> ACQUIRING -> SERVING -> WAITING_CHARGE ->
terminal` (Dock) or `gate -> ACQUIRING -> MOVING -> terminal`
(Undock). Gates reject with a single diagnostic reason: another op
active, estop latched, robot state stale, localization not ready, no
dock for the map, (undock) not at the dock, invalid request_id.

Fail-closed policy — every fault terminates the op with one reason,
zero velocity and a lease release; **the controller never retries on
its own** (acceptance: failures are diagnosable and never loop):

| Fault | Reason |
|---|---|
| lease not granted within 5 s | `REASON_CONTROL_DENIED` |
| lease lost mid-op (1 s grace) | `REASON_ABORTED` |
| pose stream stale / absent | `REASON_ABORTED` |
| robot state stale | `REASON_ABORTED` |
| estop latched | `REASON_ABORTED` |
| dock pose not reached in 45 s | `REASON_APPROACH_TIMEOUT` |
| standoff not cleared in 45 s | `REASON_MOVE_TIMEOUT` |
| docked, no charge in 30 s | `REASON_CHARGE_NOT_CONFIRMED` |
| cancel() | `REASON_USER_CANCELED` |

Charge confirmation infers charging from the BMS electricals
(`sensor_msgs/BatteryState` has no charging flag): `current` above
`charge_current_a` (sign per `charge_current_sign`), falling back to
`power > 0`; samples older than `max_age_sec` (default 2 s) are
rejected.

`DockStatus` states: `IDLE`, `UNDOCKING`, `RETURNING` (ops whose client
id carries the mission-manager `rtd-` prefix), `FINAL_APPROACH` (dock
servo), `DOCKED` (at the dock, charge unconfirmed), `CHARGING` (at the
dock, BMS confirms), `FAULT` (last op failed, not docked). `FAULT`
clears on the next terminal op; `last_reason_code`/`last_reason_text`
always carry the last terminal's diagnostics.

## Bring-up

```bash
colcon build --packages-select omni_docking
source install/setup.bash
ros2 launch omni_docking docking.launch.py
# pre-flight (see product_bringup_and_docking.md §6):
ros2 node list | grep omni_docking
ros2 topic info /omni/cmd_vel/docking   # exactly one publisher
ros2 service call /omni/docking/config omni_robot_interfaces/srv/GetDockConfig \
  "{map_id: 'floor1', map_version: ''}"
```

## Tests

The pure modules (`authority`, `dock_config`, `charge_monitor`,
`approach`, `docking_core`) have no rclpy dependency:

```bash
python3 -m unittest discover -s robot/omni_docking/test -v
```

`docking_node.py` is rclpy-only wiring (compile-checked); the
node-level behavior (action wiring, QoS, timers) needs a ROS
environment.