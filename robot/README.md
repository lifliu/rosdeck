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
- explicit mobile-control acquisition so the factory remote remains available;
- heartbeat timeout, safe lie-down/passive fallback and SDK teardown on release.

## Offline build and deployment

The target does **not** need colcon, CMake, a compiler, or this source tree.
Compile on a development machine with the same CPU architecture, ROS
distribution, and compatible system libraries as the target.

Profiles intentionally use different deployment policies:

| Profile | Build input | Default install path | Autostart |
| --- | --- | --- | --- |
| `vbot` | `vbot_ros2_msgs` | `/userdata/rosdeck` | Persistent `/userdata/startup.sh` restores a runtime systemd unit |
| `zsibot` | `zsibot_sdk-main` plus model | `/opt/rosdeck` on Orin | Persistent Bridge and Foxglove systemd services |

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
`systemctl enable --now`. Its installer also verifies that `foxglove_bridge` is
installed and enables `rosdeck-foxglove-bridge.service` on port 8765. Install a
missing Humble package before deployment:

```bash
sudo apt update
sudo apt install ros-humble-foxglove-bridge
```

Common operations on the production robot:

```bash
systemctl status rosdeck-robot-bridge
journalctl -u rosdeck-robot-bridge -f
systemctl restart rosdeck-robot-bridge
systemctl status rosdeck-foxglove-bridge
journalctl -u rosdeck-foxglove-bridge -f
```

Environment overrides are stored under `<install-prefix>/config/bridge.env`.
For VBot this is `/userdata/rosdeck/config`; for Zsibot it is
`/opt/rosdeck/config`. Both the robot Bridge and Foxglove systemd services read
this same file, so `ROS_DOMAIN_ID`, `ROS_LOCALHOST_ONLY`, and an optional
`RMW_IMPLEMENTATION` cannot silently diverge between them.

For the current Zsibot ROS graph, a fresh deployment writes these defaults:

```text
ROS_DOMAIN_ID=24
ROS_LOCALHOST_ONLY=0
RMW_IMPLEMENTATION=rmw_zenoh_cpp
```

The installer preserves an existing `bridge.env`; edit that file explicitly
when migrating an older install that already contains Domain 0 or another RMW.

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

The current two-board Zsibot layout is configured as follows:

| Role | Address | Responsibility |
| --- | --- | --- |
| Android app | Connects to Foxglove on Orin port 8765 | Publishes the stable Rosdeck topics and `/vel_cmd` |
| Orin Bridge/SDK client | `192.168.234.234:43988` | Runs both services and creates the native HighLevel SDK only while mobile control is acquired |
| RK3588 motion-control computer | `192.168.234.1` | Runs the robot motion-control server |

The RK3588 file `/opt/export/config/sdk_config.yaml` must send SDK data back to
the Orin client:

```yaml
target_ip: "192.168.234.234"
target_port: 43988
```

The matching Orin Bridge parameters are already the defaults in
`config/zsibot.yaml`:

```yaml
zsibot.local_ip: 192.168.234.234
zsibot.local_port: 43988
zsibot.dog_ip: 192.168.234.1
```

`zsibot.local_port` is the Orin callback/listen port passed as `local_port` to
the vendor `initRobot()` API. The ZSL-1W SDK demo uses `43988` for this value.
Do not replace it with the RK3588-side command port `43998`; the robot endpoint
is handled internally by the vendor SDK and is not an `initRobot()` argument.

For a ZSL-1W robot, the archive name and startup log must both contain
`zsl-1w`. Build it explicitly with:

```bash
./scripts/build-package.sh --profile zsibot --zsibot-model zsl-1w
```

After deploying, verify that the runtime is using the new package rather than a
previous config:

```bash
grep -E 'local_(ip|port)|dog_ip' /opt/rosdeck/config/bridge.yaml
journalctl -u rosdeck-robot-bridge -n 100 --no-pager
```

At boot the startup log must say `Zsibot SDK is idle until control is acquired`;
it must not print `mp_recv_cp` until the App requests control. Each acquisition
checks that `192.168.234.234` is assigned before calling `initRobot()`, so an
early network error is retryable and does not require restarting the service.

The adapter logs every posture/LOCO result and throttled velocity samples. It
also emits a ten-second diagnostic containing the SDK connection, control mode,
battery, ROS `/vel_cmd` publisher count, received/forwarded counts, ignored zero
messages, and the last decoded SDK result. ZSL-1W codes such as `0x3007`
(state-machine transition failure) and `0x3013` (velocity out of range) are
translated in both the journal and App acknowledgement.

The App can continuously publish zero `Twist` values while its control screen is
open. The Zsibot adapter now sends only the first stop after real motion and
ignores subsequent idle zeros, because repeatedly invoking the vendor `move()`
API can interfere with posture state transitions. Touching the joystick sends a
LOCO request; for Zsibot this automatically calls `standUp()` when necessary and
waits for standing mode before allowing non-zero velocity through. The App also
blocks posture and non-zero velocity locally until it owns the control lease.

### Zsibot control ownership

The Bridge process is always running, but the vendor `HighLevel` object is not.
The App's **Take Control** button creates the SDK object and starts a one-second
heartbeat. Only that App session can renew or release the lease. A normal
release sends zero velocity, requests lie-down, waits for passive mode, and
uses `passive()` as a timeout/error fallback before destroying the SDK object.
The Bridge then exposes a three-second cooldown matching the RK3588 SDK-loss
watchdog before reporting that the factory remote is available.

If the phone crashes, loses Wi-Fi, closes the connection, or goes into the
background, the five-second lease expires and runs the same safe release path.
Another phone cannot release or renew the current owner's lease. Relevant
parameters are under `zsibot.control.*` in `config/zsibot.yaml`.

The control status is broadcast every 500 ms in addition to direct command
responses. This handles the short Foxglove publisher-discovery race during App
connection and lets a late subscriber immediately recover the current owner or
cooldown state.

All addresses are on `192.168.234.0/24`, so the vendor `SDK_CLIENT_IP` override
for cross-subnet control is not required. If either board's address or the UDP
port changes, update both sides together. This is a Bridge/client configuration;
the Android app does not contain or link the Zsibot SDK.

## Stable phone protocol

| Direction | Topic | Type | Payload |
| --- | --- | --- | --- |
| App → robot | `/rosdeck/start_3d_mapping` | `std_msgs/msg/Bool` | `true` start, `false` stop |
| Robot → app | `/rosdeck/mapping_status` | `std_msgs/msg/String` | `started:*`, `stopped:*`, `error:*` |
| App → robot | `/rosdeck/posture_command` | `std_msgs/msg/String` | `stand`, `lie_down` |
| Robot → app | `/rosdeck/posture_status` | `std_msgs/msg/String` | `success:*`, `error:*` |
| App → robot | `/rosdeck/locomotion_command` | `std_msgs/msg/String` | `loco` |
| Robot → app | `/rosdeck/locomotion_status` | `std_msgs/msg/String` | `success:loco`, `error:loco:*` |
| App → robot | `/rosdeck/control_command` | `std_msgs/msg/String` | `status:<id>`, `acquire:<id>`, `heartbeat:<id>`, `release:<id>` |
| Robot → app | `/rosdeck/control_status` | `std_msgs/msg/String` | `available`, `acquiring:<id>`, `acquired:<id>`, `releasing:<id>`, `cooldown:<seconds>`, `error:*` |

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
