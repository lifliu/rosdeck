# Robot integration boundary

`rosdeck` owns the mobile App and the authenticated, App-facing WebSocket
gateway. Robot mission policy, docking control and vendor SDK access are
maintained and released independently.

## Repository ownership

| Repository | Responsibility | Must not own |
| --- | --- | --- |
| [`rosdeck`](https://github.com/lifliu/rosdeck) | App UI, pairing, authentication, RBAC and `omni_ws_gateway` | Mission state, motion arbitration or vendor SDKs |
| [`omni_mission_manager`](https://github.com/YanYaoyuan/omni_mission_manager) | Mission state, routes, checkpoints, persistence and return-to-dock orchestration | SLAM, final docking or SDK access |
| [`omni_docking`](https://github.com/YanYaoyuan/omni_docking) | Dock geometry, final approach, undock and charging verification | Global planning, App transport or SDK access |
| [`omni_robot_bridge`](https://github.com/YanYaoyuan/omni_robot_bridge) | Sole vendor SDK ownership, robot adaptation, command authority, safety arbitration and aggregate state | Mission policy, planning or App UI |
| [`omni_robot_interfaces`](https://github.com/YanYaoyuan/omni_robot_interfaces) | Stable cross-repository ROS 2 interfaces | Runtime behavior |
| [`omni_tf_manager`](https://github.com/YanYaoyuan/omni_tf_manager) | Canonical frame names, static extrinsics and TF readiness | SLAM estimation or mission logic |
| [`omni_slam`](https://github.com/YanYaoyuan/omni_slam) | Mapping/localization pose and status | Static sensor TF ownership |
| [`SCAN-Planner`](https://github.com/YanYaoyuan/SCAN-Planner) | Route planning and navigation velocity generation | Vendor transport or command authority |

The former in-tree copies of `omni_mission_manager`, `omni_docking` and
`rosdeck_robot_bridge` were extracted on 2026-08-25. New changes belong in the
repositories above; do not vendor the packages back into this App repository.

## Runtime data flow

```text
Rosdeck App
    |
    | authenticated WSS / typed mission APIs
    v
omni_ws_gateway -------> foxglove_bridge
                              |
                              v
omni_mission_manager ---- FollowRoute ----> SCAN-Planner
          |                                    |
          | Dock/GetDockConfig                 | navigation cmd_vel
          v                                    v
     omni_docking ---- docking cmd_vel ---> omni_robot_bridge ---> vendor SDK
          ^                                    ^
          | RobotState/Battery                 | SlamStatus / TF readiness
          +------------------------------------+---- omni_slam
                                                   omni_tf_manager
```

Only `omni_robot_bridge` may own the vendor SDK or emit the final robot
velocity. The App, Planner and Docking publish to separate inputs; the Bridge
selects one authorized, fresh command and applies E-stop and motion limits.

## Key ROS interfaces

| Owner | Interface | Purpose |
| --- | --- | --- |
| Mission Manager | `/omni/mission/execute`, `/omni/mission/dispatch` | Start an inspection mission |
| Mission Manager | `/omni/mission/control`, `/omni/mission/status` | Pause/resume/cancel and observe state |
| Mission Manager | `/omni/mission/runtime/set_mode`, `/omni/mission/runtime/status` | Ensure mapping, localization, navigation, or route-recording capability |
| Mission Manager | `/omni/mission/navigation/submit`, `/omni/mission/navigation/cancel`, `/omni/mission/navigation/status` | Submit, cancel, and observe a map-bound point-navigation operation |
| Mission Manager | `/omni/mission/runtime/finish_mapping`, `/omni/mission/runtime/finish_route_recording` | Explicitly save or discard an asset session |
| Mission Manager | `/omni/maps/list` | Return the verified current map catalog for cold-start App selection |
| Mission Manager | `/omni/mission/return_to_dock` | Global return and docking handoff |
| Docking | `/omni/docking/dock`, `/omni/docking/undock` | Final docking operations |
| Docking | `/omni/docking/config`, `/omni/docking/status` | Dock pose lookup and state |
| Planner | `/omni/navigation/follow_route`, `/scan_planner/cmd_vel` | Route execution and navigation velocity |
| Robot Bridge | `/omni/control/authority` | Target typed command lease contract |
| Robot Bridge | `/omni/robot_state`, `/battery_state`, `/diagnostics` | Product state and health |
| TF Manager | `/omni/tf_manager/ready`, `/omni/slam/status` | TF and localization readiness gates |

The operator role permits the Mission services above by exact name; it is not
allowed to publish Planner goal or velocity topics. It may call the public
`/omni/maps/list`, but not the SLAM-internal `/omni/slam/maps/list`. The App and
Mission use the typed `/omni/control/authority` service. The Bridge
temporarily retains `/rosdeck/control_command` and `/rosdeck/control_status` as
an internal compatibility façade for older deployments; the operator gateway
does not grant new APP clients permission to publish the legacy command topic.

Detailed QoS, payload and compatibility requirements live in each runtime
repository's `docs/INTERFACES.md`; their `docs/TODO.md` is the authoritative
implementation backlog.

## Startup and readiness

1. `omni_tf_manager` validates the robot model and publishes TF readiness.
2. `omni_slam` enters mapping or localization and publishes a valid status.
3. `omni_robot_bridge` acquires the sole SDK lock and starts fail-closed safety
   supervision.
4. `omni_docking`, `omni_mission_manager` and SCAN-Planner may start, but must
   reject motion until TF, localization and robot-state gates are ready.
5. `omni_ws_gateway` and the App expose authenticated commands only after the
   robot runtime is observable.

Processes may start in parallel under systemd; readiness gates, not process
existence, decide whether motion is accepted.

## App-facing gateway kept here

`robot/omni_ws_gateway` remains in this repository because it is part of the
App security boundary. It provides TLS/WSS termination, login, role policy and
audit logging in front of loopback-only `foxglove_bridge`.

Run its no-ROS regression suite with:

```bash
python3 -m unittest discover -s robot/omni_ws_gateway/test -v
```

Build it as a ROS 2 package when validating the App gateway workspace:

```bash
colcon build --packages-select omni_ws_gateway
```

Robot runtime build, deployment, A/B update and rollback procedures now live
in `omni_robot_bridge`; this App repository no longer ships those artifacts.
