# Rosdeck robot bridge

`rosdeck_robot_bridge` is the production robot-side companion for the Android
app. It is a ROS 2 C++ node with a stable phone-facing topic protocol and
replaceable robot adapters. The included `vbot` adapter supports:

- starting/stopping 3D mapping, including SIGINT map saving;
- stand and lie-down through `software_msgs/srv/LowlevelAction`;
- switching to MODE_LOCO through `function_msgs/srv/SetRunMode` before
  accepting joystick velocity commands.

## Offline build and deployment

The production robot does **not** need colcon, CMake, a compiler, or this source
tree. Compile on an S100 development board that has the same CPU architecture,
ROS distribution, and compatible system libraries as the target robot.

On the S100 development board:

```bash
cd rosdeck_robot_bridge
./scripts/build-package.sh --profile vbot
```

The output is written under `dist/`:

```text
rosdeck-robot-bridge-<version>-vbot-<arch>-humble.tar.gz
rosdeck-robot-bridge-<version>-vbot-<arch>-humble.tar.gz.sha256
```

The VBot package always compiles and embeds the matching `function_msgs`,
`software_msgs`, and `foxglove_msgs` runtime libraries. Keep the SDK next to
`rosdeck_robot_bridge`; the script detects it automatically:

```bash
cd ~/robot
git clone https://github.com/VitaDynamics/vbot_ros2_msgs.git
cd rosdeck_robot_bridge
./scripts/build-package.sh --profile vbot
```

If the SDK is stored somewhere else, pass its real absolute path, for example
`--vbot-msgs /home/sunrise/sdk/vbot_ros2_msgs`. Do not copy the literal
placeholder `/path/to/vbot_ros2_msgs`.

Copy the archive to the production machine dog, then run:

```bash
sha256sum -c rosdeck-robot-bridge-*.tar.gz.sha256
tar -xzf rosdeck-robot-bridge-*.tar.gz
cd rosdeck-robot-bridge-*/
sudo ./deploy.sh
```

The bundle's `deploy.sh` performs no compilation. It checks the CPU architecture,
ROS distribution, bundled VBot runtime interfaces, and shared libraries;
installs the binary and its private runtime under `/userdata/rosdeck`; enables
systemd autostart; starts the service; and prints recent logs if startup fails.
The production robot only needs its base ROS runtime. The complete node runs on
**S100 only** and reaches the other VBot processes through the existing ROS
2/Zenoh graph.

On VBot, both deployment checks and the systemd launcher automatically source
`/app/script/env.sh` before the bundled runtime. Deployment also adds an
idempotent Rosdeck entry to the persistent `/userdata/startup.sh`; at every boot it
restores the runtime systemd unit and starts the service. If another robot uses
a different environment entry point, install with `./deploy.sh --ros-setup PATH`.

Common operations on the production robot:

```bash
systemctl status rosdeck-robot-bridge
journalctl -u rosdeck-robot-bridge -f
systemctl restart rosdeck-robot-bridge
```

Environment overrides such as `RMW_IMPLEMENTATION` can be placed in
`/userdata/rosdeck/config/bridge.env`, one `KEY=value` per line. Restart the service after
editing it.

`scripts/build.sh` and `scripts/deploy.sh` remain developer conveniences for a
board that has colcon. Production deployment should use the generated archive.

## Configuration

The active configuration is `/userdata/rosdeck/config/bridge.yaml`. The installer supplies
two robot-family profiles under `config/`:

- `vbot.yaml`: complete VBot bridge, deployed on S100;
- `zsibot.yaml`: reserved Zsibot adapter profile.

The mapping script and log paths are parameters, so a different robot does not
need to use `/userdata/2_slam/1_mapping.sh`.

Stopping mapping first sends SIGINT to the complete mapping process group so
FAST-LIO can save `map.pcd`. The bridge checks that the whole group has exited,
not only the launch script: after `mapping.stop_timeout_sec` it escalates to
SIGTERM, then after `mapping.kill_timeout_sec` to SIGKILL. Both timeouts are
configurable in `bridge.yaml`.

`ZsibotAdapter` already implements the stable adapter boundary. Until the
Zsibot SDK service/action definitions are provided, it returns the explicit
`zsibot_adapter_not_configured` status and does not execute VBot-specific
commands. Adding Zsibot support later only requires filling in
`src/zsibot_adapter.cpp` and its configuration; the Android app stays unchanged.

## Stable phone protocol

| Direction | Topic | Type | Payload |
| --- | --- | --- | --- |
| App → robot | `/rosdeck/start_3d_mapping` | `std_msgs/msg/Bool` | `true` start, `false` stop |
| Robot → app | `/rosdeck/mapping_status` | `std_msgs/msg/String` | `started:*`, `stopped:*`, `error:*` |
| App → robot | `/rosdeck/posture_command` | `std_msgs/msg/String` | `stand`, `lie_down` |
| Robot → app | `/rosdeck/posture_status` | `std_msgs/msg/String` | `success:*`, `error:*` |
| App → robot | `/rosdeck/locomotion_command` | `std_msgs/msg/String` | `loco` |
| Robot → app | `/rosdeck/locomotion_status` | `std_msgs/msg/String` | `success:loco`, `error:loco:*` |

Keeping these topics stable means future robot support only requires another
C++ `RobotAdapter`; the Android app and Foxglove connection do not change.
For backward compatibility, the current app falls back to the VBot
`/locomotion/set_run_mode` service when the locomotion status topic is absent.

## Manual build

```bash
source /app/script/env.sh
mkdir -p ~/rosdeck_ws/src
cp -a rosdeck_robot_bridge ~/rosdeck_ws/src/
cd ~/rosdeck_ws
colcon build --packages-select rosdeck_robot_bridge --cmake-args -DCMAKE_BUILD_TYPE=Release
source install/setup.bash
ros2 run rosdeck_robot_bridge rosdeck_robot_bridge_node \
  --ros-args --params-file src/rosdeck_robot_bridge/config/vbot.yaml
```

For VBot, `function_msgs` and `software_msgs` must be visible in the sourced ROS
environment. Without them, the core mapping node still builds, but the VBot
adapter is omitted.

## Removal

```bash
sudo ./scripts/uninstall.sh
```

The uninstaller disables autostart and retains `/userdata/rosdeck` so the
installation can be recovered or inspected.
