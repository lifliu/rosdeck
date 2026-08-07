# Rosdeck robot bridge

`rosdeck_robot_bridge` is the production robot-side companion for the Android
app. It is a ROS 2 C++ node with a stable phone-facing topic protocol and
replaceable robot adapters.

The `vbot` adapter supports:

- starting/stopping 3D mapping, including SIGINT map saving;
- stand and lie-down through `software_msgs/srv/LowlevelAction`;
- switching to MODE_LOCO through `function_msgs/srv/SetRunMode` before
  accepting joystick velocity commands.

The `zsibot` adapter uses the official native HighLevel SDK and supports:

- ZSL-1 and ZSL-1W selected at build time;
- `standUp()` / `lieDown()` posture control;
- `/vel_cmd` conversion to `move(vx, vy, yaw_rate)`;
- SDK connection checks before accepting locomotion commands.

## Offline build and deployment

The target does **not** need colcon, CMake, a compiler, or this source tree.
Compile on a development machine with the same CPU architecture, ROS
distribution, and compatible system libraries as the target.

Profiles intentionally use different deployment policies:

| Profile | Build input | Default install path | Autostart |
| --- | --- | --- | --- |
| `vbot` | `vbot_ros2_msgs` | `/userdata/rosdeck` | Persistent `/userdata/startup.sh` restores a runtime systemd unit |
| `zsibot` | `zsibot_sdk-main` plus model | `/opt/rosdeck` | Normal persistent systemd service |

`/userdata` and `/userdata/startup.sh` are VBot-specific and are never used by a
Zsibot bundle.

### VBot package

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

### Zsibot package

Keep the vendor SDK at `sdk/zsibot_sdk-main` for automatic discovery, or pass
its actual location with `--zsibot-sdk`. The SDK contains vendor binaries and
is intentionally not committed to this repository. The robot model must be
selected explicitly so the wrong ABI/library cannot be packaged:

```bash
# Four-legged ZSL-1
./scripts/build-package.sh \
  --profile zsibot \
  --zsibot-model zsl-1

# Wheeled-legged ZSL-1W
./scripts/build-package.sh \
  --profile zsibot \
  --zsibot-model zsl-1w
```

The output name includes the selected model, for example:

```text
rosdeck-robot-bridge-<version>-zsibot-zsl-1-aarch64-humble.tar.gz
```

Copy the archive to the production machine dog, then run:

```bash
sha256sum -c rosdeck-robot-bridge-*.tar.gz.sha256
tar -xzf rosdeck-robot-bridge-*.tar.gz
cd rosdeck-robot-bridge-*/
sudo ./deploy.sh
```

The bundle's `deploy.sh` performs no compilation. It validates architecture,
ROS distribution and shared libraries, then applies the deployment policy from
its manifest. A VBot package installs on S100 under `/userdata/rosdeck`; a
Zsibot package installs under `/opt/rosdeck` on the Ubuntu computer that runs
the bridge and communicates with the robot over the vendor SDK.

On VBot, both deployment checks and the systemd launcher automatically source
`/app/script/env.sh` before the bundled runtime. Deployment also adds an
idempotent Rosdeck entry to the persistent `/userdata/startup.sh`; at every boot it
restores the runtime systemd unit and starts the service. If another robot uses
a different environment entry point, install with `./deploy.sh --ros-setup PATH`.

Zsibot does not source the VBot environment and does not modify anything under
`/userdata`. It uses the standard ROS setup under `/opt/ros/<distro>` and
`systemctl enable --now`.

Common operations on the production robot:

```bash
systemctl status rosdeck-robot-bridge
journalctl -u rosdeck-robot-bridge -f
systemctl restart rosdeck-robot-bridge
```

Environment overrides are stored under `<install-prefix>/config/bridge.env`.
For VBot this is `/userdata/rosdeck/config`; for Zsibot it is
`/opt/rosdeck/config`.

`scripts/build.sh` and `scripts/deploy.sh` remain developer conveniences for a
board that has colcon. Production deployment should use the generated archive.

## Configuration

The active configuration is `<install-prefix>/config/bridge.yaml`. The
installer supplies two robot-family profiles under `config/`:

- `vbot.yaml`: complete VBot bridge, deployed on S100;
- `zsibot.yaml`: official HighLevel SDK adapter; mapping remains disabled until
  a Zsibot mapping interface is supplied.

The mapping script and log paths are parameters, so a different robot does not
need to use `/userdata/2_slam/1_mapping.sh`.

Stopping mapping first sends SIGINT to the complete mapping process group so
FAST-LIO can save `map.pcd`. The bridge checks that the whole group has exited,
not only the launch script: after `mapping.stop_timeout_sec` it escalates to
SIGTERM, then after `mapping.kill_timeout_sec` to SIGKILL. Both timeouts are
configurable in `bridge.yaml`.

For Zsibot, set `zsibot.local_ip`, `zsibot.local_port`, and `zsibot.dog_ip` to
match `/opt/export/config/sdk_config.yaml` and the selected network. The vendor
SDK requires movement state transitions to be respected: stand before sending
non-zero velocity, and send zero velocity before stand/lie-down transitions.

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

## Manual VBot build

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
environment. Production packages build and embed them automatically.

## Removal

```bash
sudo ./scripts/uninstall.sh
```

The uninstaller disables the service. The profile-specific install directory is
retained so the installation can be recovered or inspected.
