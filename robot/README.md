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
- an authority-gated `/omni/cmd_vel/final` conversion to
  `move(vx, vy, yaw_rate)`;
- explicit mobile-control acquisition so the factory remote remains available;
- heartbeat timeout, safe lie-down/passive fallback and SDK teardown on release.

The package also installs a separate `rosdeck_safety_supervisor_node`. It is the
only product component allowed to publish the reliable periodic
`/omni/safety/estop` heartbeat consumed by the Bridge. A host-wide lock rejects
a second supervisor process, while the Bridge rejects multiple ROS publishers.

The supported product entry point is `product_bringup.launch.py`; it starts the
Gateway and safety supervisor as one service boundary. Source and offline
deployment launchers use this entry point rather than executing the Gateway
binary directly. OpenNav Docking integration and its scoped `cmd_vel` remap are
documented in `rosdeck_robot_bridge/doc/product_bringup_and_docking.md`.

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
installed, enables `rosdeck-foxglove-bridge.service` on loopback port 8766, and
enables the TLS WebSocket gateway `omni-ws-gateway.service`, which owns the
app-facing `wss://…:8765` (see [Secure mobile access](#secure-mobile-access-ws-gateway)).
Install a missing Humble package before deployment:

```bash
sudo apt update
sudo apt install ros-humble-foxglove-bridge
```

### Release manifest, SBOM and signing

Every generated bundle embeds a machine-readable release description so the
robot can prove what was shipped without the build machine:

```text
release-manifest.json     schema, version, profile, arch, ROS distro, pinned
                          source revisions (git sha + dirty flag, or a tree
                          content hash for vendor drops), tool versions,
                          installed ROS system packages, staged workspace
                          packages, config hash, signing key fingerprint
sbom.json                 CycloneDX 1.5: workspace packages, system ROS
                          packages and source repos with VCS references
tools/release_artifacts.py  the verifier itself, shipped inside the bundle
```

The archive is deterministic: identical source pins, toolchain, ROS
distribution and vendor inputs produce a byte-identical `tar.gz` (fixed entry
order, owner, modes and mtime, timestampless gzip). Metadata time comes from
`SOURCE_DATE_EPOCH` when set, otherwise from the last rosdeck commit; the
manifest records which origin was used. Different compiler or ROS patch
releases are not guaranteed bit-for-bit identical — the manifest is the audit
record in that case.

Signing is optional. Build with a GPG key id or fingerprint:

```bash
./scripts/build-package.sh --profile zsibot --zsibot-model zsl-1 \
  --sign-key <key-id-or-fingerprint>
```

This writes a detached armored signature next to the archive
(`<archive>.tar.gz.asc`) and records the key fingerprint in the manifest.
An existing archive can be signed later on any machine that holds the key:

```bash
python3 scripts/release_artifacts.py sign <archive>.tar.gz --key <key-id>
```

Verification on the robot (the tool travels inside the bundle):

```bash
# Full check: sha256 sidecar, GPG signature (when a .asc is present),
# embedded manifest consistency and staged package completeness.
python3 <bundle>/tools/release_artifacts.py verify <archive>.tar.gz

# Deploy-time self-check: deploy.sh runs verify-bundle automatically and
# aborts before installing anything if the bundle no longer matches its
# manifest.
python3 <bundle>/tools/release_artifacts.py verify-bundle <bundle>
```

Trust the release key by importing its public key on the robot
(`gpg --import rosdeck-release.pub`); `verify` then checks the signature
against the keyring.

### OTA upgrades and rollback (A/B releases)

Production installs are userland A/B release slots: every bundle becomes a
complete directory under `<install-prefix>/releases/<id>/` and the service
always runs from `<install-prefix>/current`, a symlink that is swapped
atomically (temp symlink + `rename`). Shared state — env files, systemd
units, `ota.sh`, the deploy library, logs — lives outside the slots:

```text
<install-prefix>/
  releases/
    0.1.0-zsl-1-1767225600/   full bundle: bin, runtime, config, tools
    legacy-20260818120000/    only on converted installs: the old in-place tree
  current -> releases/<id>    active release
  previous -> releases/<id>   what was active immediately before current
  bin/        generated launchers + ota.sh
  config/     bridge.env, foxglove.env (shared, operator-managed)
  lib/        deploy-core.sh
  log/  systemd/
```

The release id is `<version>[-<model>]-<source_epoch>` from the embedded
manifest, so it is a content identity: re-deploying the same bundle is a
no-op, and every slot name is reproducible from the manifest.

**First install** uses the bundle's `deploy.sh` (as before). When an old
in-place install exists, it is *adopted*: its `runtime/` tree and node binary
are moved into a `legacy-…` slot and registered as `previous`, so the very
first A/B upgrade already has a rollback target, and a hand-tuned
`<install-prefix>/config/bridge.yaml` is carried over into the new slot.

**Upgrades** run on the robot with the installed tool:

```bash
sudo /opt/rosdeck/bin/ota.sh install /path/to/<new-archive>.tar.gz
#   --signature <new-archive>.tar.gz.asc   also verify the GPG signature
#   --keep N                               release slots to retain (default 3)
#   --no-start                             install + switch without restarting yet
```

The archive is verified with the **active** release's own verifier (sha256
sidecar + optional GPG — never with a tool shipped inside the archive being
installed), the bundle's profile and, for Zsibot, its model must match the
running release, then a new slot is staged, `current` is swapped, the service
is restarted and the bringup health check runs. If the new release fails to
come up or fails the health check, `ota.sh` **rolls back automatically** and
reports the failure. Slots are pruned to the newest N (current/previous are
never pruned).

**Manual rollback / inspection:**

```bash
sudo /opt/rosdeck/bin/ota.sh rollback    # swap current/previous, restart
/opt/rosdeck/bin/ota.sh status           # current, previous, retained slots
```

Worst case, the layout is plain files — point `current` at any slot by hand
and restart:

```bash
sudo rm /opt/rosdeck/current
sudo ln -s releases/<id> /opt/rosdeck/current
sudo systemctl restart rosdeck-robot-bridge
```

Bundles built before the A/B layout have no `lib/deploy-core.sh` and can no
longer be deployed by the current `deploy.sh`; rebuild from current rosdeck.

### Service account and unit hardening

All units run as the dedicated `rosdeck` system account, never as root. Both
deployers (the in-place `deploy.sh` and the A/B core used by the bundle's
`deploy.sh` / `ota.sh`) create it idempotently before rendering the units — a
system group and a `nologin` user — and chown existing root-owned state into
the account on every deploy, so installs that previously ran as root upgrade
cleanly:

- The release tree stays root-owned and world-readable; no runtime process
  needs to write into it.
- Mission manager state (route store under `/var/lib/omni/routes`, SQLite DB
  under `/var/lib/omni/mission_manager`) is owned by `rosdeck` and survives
  reboots (`StateDirectory=omni`; an `ExecStartPre` self-heals the
  subdirectories on every start).
- The safety-supervisor instance lock lives in `/run/lock/omni`, created per
  start and removed on stop (`RuntimeDirectory=lock/omni`) — a stale lock can
  never outlive the service.
- On VBot only, the bridge unit additionally gets
  `ReadWritePaths=/userdata` because the vendor 3D mapping child writes map
  data there; the template renders that line as a comment for every other
  profile.

Each unit carries the standard conservative sandbox: `NoNewPrivileges`,
`PrivateTmp`, `PrivateDevices`, `ProtectSystem=strict`, `ProtectHome`,
kernel-tunables/modules/logs protections, `ProtectControlGroups`,
`ProtectClock`, `ProcSubset=pid`, and an address-family allowlist (Unix,
IPv4/IPv6, netlink for interface enumeration). The mission manager and
Foxglove units additionally drop every capability (`CapabilityBoundingSet=`).

Resource caps: the bridge cgroup gets `TasksMax=1024`, `MemoryHigh=2G`,
`MemoryMax=4G`, `LimitNOFILE=65536` and deliberately **no** `CPUQuota` — it
feeds the motion loop, so a CPU cap would trade motion safety for accounting.
The mission manager is capped at `CPUQuota=200%`, `MemoryMax=2G`; Foxglove at
`CPUQuota=200%`, `MemoryMax=1G`; the WS gateway at `CPUQuota=200%`,
`MemoryMax=512M`, `TasksMax=512`.

Three directives are intentionally **not** set until the full stack has been
HIL-verified under them (the unit comments say the same): `SystemCallFilter`
and `MemoryDenyWriteExecute` on every unit, and `CapabilityBoundingSet` on
the bridge — the closed-source vendor SDK (Zsibot) and the vendor SLAM child
(VBot) run inside the bridge cgroup, and none of these has been exercised
against them yet. The A/B auto-rollback is the safety net for adding them
later, one at a time, with the health check as the gate.

Common operations on the production robot:

```bash
systemctl status rosdeck-robot-bridge
journalctl -u rosdeck-robot-bridge -f
systemctl restart rosdeck-robot-bridge
systemctl status rosdeck-foxglove-bridge
journalctl -u rosdeck-foxglove-bridge -f
systemctl status omni-ws-gateway
journalctl -u omni-ws-gateway -f
```

Environment overrides are stored under `<install-prefix>/config/bridge.env`.
For VBot this is `/userdata/rosdeck/config`; for Zsibot it is
`/opt/rosdeck/config`. Both the robot Bridge and Foxglove systemd services read
this same file, so `ROS_DOMAIN_ID`, `ROS_LOCALHOST_ONLY`, and an optional
`RMW_IMPLEMENTATION` cannot silently diverge between them. Foxglove also reads
the sibling `foxglove.env`; the deployer converges it to
`FOXGLOVE_ADDRESS=127.0.0.1` / `FOXGLOVE_PORT=8766` (idempotent), and the WS
gateway's own listen/upstream addresses are fixed in its unit file.

### Secure mobile access (WS gateway)

The app-facing listener is no longer the raw `foxglove_bridge`. A thin
`omni_ws_gateway` ament_python package terminates TLS in front of it, then
requires a one-time token login and enforces per-role access control before
forwarding frames byte-for-byte to the loopback Foxglove port. The
client's requested WebSocket subprotocol (e.g. `foxglove.sdk.v1`) is
echoed in the 101 response and passed through to the upstream handshake,
so the framing version the app negotiates is preserved:

| Service | Listens | What it does |
| --- | --- | --- |
| `omni-ws-gateway` | `0.0.0.0:8765` (wss) | TLS termination on a self-signed ECDSA P-256 device cert, first-message token login, per-role RBAC, append-only JSONL audit |
| `rosdeck-foxglove-bridge` | `127.0.0.1:8766` (plain ws) | Upstream; receives only what the gateway forwards |

The deployer converges `foxglove.env` to this split idempotently, so a
pre-gateway install (which ran Foxglove on `0.0.0.0:8765`) upgrades without
manual editing. The device certificate is generated **once** under
`/var/lib/omni/tls` — an existing pair is preserved, so the app's SPKI
certificate pin survives re-deploys and OTA upgrades. The auth store lives in
`/var/lib/omni/auth`, the audit trail in `/var/lib/omni/audit` (metadata-only
JSONL, 30-day retention, 10 MiB/day rotation to `.1`).

Pair a phone, then connect the app over `wss://<orin-ip>:8765` and send the
token as the first message:

```bash
# A/B install: source the active slot's runtime so ros2 can find the package
source /opt/ros/humble/setup.bash
source /opt/rosdeck/current/runtime/local_setup.bash

# create a user; the token is printed ONCE (only its SHA-256 is stored)
ros2 run omni_ws_gateway omni-auth add-user alice --role operator
# inspect / revoke
ros2 run omni_ws_gateway omni-auth list
ros2 run omni_ws_gateway omni-auth remove-user alice
# device cert PEM + the SPKI SHA-256 pin the app must trust
ros2 run omni_ws_gateway omni-auth show-pairing
```

Roles (fail-closed; anything not explicitly allowed is denied):

- `viewer` — subscribe/unsubscribe only.
- `operator` — viewer plus publish/advertise on `/omni/cmd_vel/*`,
  `/omni/safety/*`, `/omni/mission/*`, `/omni/navigation/*`, `/rosdeck/*`, and
  service calls on those namespaces plus `/omni/routes/*`.
- `admin` — every op, topic and service.

A JSON policy file at `/var/lib/omni/auth/policy.json` can override the
built-in defaults per role (partial files merge over the defaults). Denied
frames are dropped and an `error` op is returned; a login timeout or bad token
closes the socket with code 1008. Old `ws://…:8765` clients (pre-gateway app
builds) can no longer connect until the app moves to wss + pairing.

When a rollback restores a release that predates the gateway package, the
deployer withdraws the gateway unit so it cannot crash-loop against a runtime
that has no `omni_ws_gateway`.

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

The active configuration is `<install-prefix>/current/config/bridge.yaml` —
the copy owned by the release slot behind `current` (see A/B releases
above). Pre-A/B installs kept it at `<install-prefix>/config/bridge.yaml`;
that file is left in place when an install is converted and is carried over
into the first slot. The
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
| Android app | Connects to the WS gateway on Orin `wss://…:8765` (pairing token) | Publishes stable Rosdeck topics and unified `TwistStamped` teleop on `/omni/cmd_vel/teleop`; `/vel_cmd` remains the legacy VBot fallback |
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
battery, final-command publisher count, received/forwarded counts, zero and
deadband stops, invalid/limited commands, watchdog stops, stop failures, and the
last decoded SDK result. ZSL-1W codes such as `0x3007`
(state-machine transition failure) and `0x3013` (velocity out of range) are
translated in both the journal and App acknowledgement.

### Two-stage software E-stop

The supervisor starts fail-closed and publishes `true`. It can publish `false`
only after an explicit call to its arm service. Any `true` received on
`/omni/safety/estop_request`, a missed supervisor heartbeat deadline, a manual
latch request, a supervisor restart, or loss of the supervisor heartbeat makes
the system latch again. A `false` request never clears a latch.

Recovery intentionally has two independent stages; neither node calls the
other node's reset service:

```bash
# Stage 1: make the sole supervisor heartbeat healthy (false).
ros2 service call /omni/safety/arm_supervisor std_srvs/srv/Trigger '{}'

# Inspect state=armed and output_estop=false before continuing.
ros2 topic echo --once /omni/safety/supervisor_status

# Stage 2: explicitly clear the Bridge latch. Cached velocity is already gone,
# so a new authorized command is required before motion resumes.
ros2 service call /omni/safety/reset_estop std_srvs/srv/Trigger '{}'
```

For Zsibot, Stage 2 is rejected until the Bridge has confirmed a direct zero
command at the adapter. A failed direct stop is retried at most three times;
publisher-conflict traffic cannot trigger an unbounded stream of SDK calls. If
all attempts fail, the ordinary reset remains locked out and operator recovery
must repair/restart the adapter path rather than bypassing the stop failure.
While the latch is active, Zsibot may establish an authorization-only control
lease so the App can perform the two-stage recovery. Velocity, posture and
locomotion remain blocked. Initial SDK construction and the later connected
acquire completion each invalidate older direct-stop confirmation; Stage 2 is
rejected until the lease is acquired and a zero command is freshly confirmed
for that session. An SDK-idle startup confirmation can therefore never be
reused by a later session. Heartbeat, status and release remain available.

To assert E-stop, any safety source may publish `true`; false is ignored:

```bash
ros2 topic pub --once /omni/safety/estop_request std_msgs/msg/Bool '{data: true}'
# Equivalent local operator action:
ros2 service call /omni/safety/latch_estop std_srvs/srv/Trigger '{}'
```

Supervisor status is a transient-local `std_msgs/msg/String` on
`/omni/safety/supervisor_status`. The normal Zsibot configuration publishes the
E-stop heartbeat every 100 ms and both the supervisor and Bridge treat a 500 ms
gap as unhealthy. The supervisor never auto-arms, including after a process
restart. `launch/bridge.launch.py` starts both critical nodes as one launch
epoch; if either node exits, the launch shuts down and systemd restarts the
complete Gateway + supervisor boundary. The restarted supervisor still
requires the two-stage recovery above.

Production systemd runs as root and owns `/run/lock/omni/safety_supervisor.lock`.
For a non-root development launch only, set `OMNI_SAFETY_SUPERVISOR_LOCK` to an
absolute lock-file path in a directory owned by that developer; do not set this
override in the production service environment.

This is a software stop layer, not a substitute for a wired E-stop or the
motion controller's own command timeout. An SDK call that blocks its process
cannot be made safe by another callback in that same process. Phase 0 does not
yet connect a GPIO/PLC hardware E-stop or an independent hardware-health input;
those signals must be added before treating this as a product safety system.
Before claiming a stopping-time bound, run Orin/Zsibot HIL fault injection and
measure worst-case latency while vendor SDK calls are delayed or unresponsive.

### Adapter and battery observability

The Bridge publishes a thread-safe copy of telemetry already cached by each
adapter. Publishing never calls `checkConnect()`, `getCurrentCtrlmode()`,
`getBatteryPower()`, or another vendor API. Zsibot connection and mode samples
come from its existing 250 ms SDK poll.

`/battery_state` merges the kernel BMS with the vendor SDK:

- Real electrical data — `voltage`, `current`, `temperature`,
  `power_supply_status`, `power_supply_health`, and sysfs `present` — comes
  from the Linux power-supply class (`/sys/class/power_supply`), read with a
  1 s TTL so the 1 Hz adapter timer and the 4 Hz `/omni/robot_state` tick
  share one read. The device is auto-detected (the `Battery` type exposing
  `voltage_now`) unless `adapter_status.battery.power_supply_device` pins one.
- The vendor SDK only provides SOC (0–100). It stays the primary
  `percentage` source and feeds the SOC-trend fallback; when the SDK sample
  is stale, the percentage falls back to the sysfs `capacity` instead of
  blanking.
- The `charging` bit is confirmed in priority order: BMS
  `power_supply_status` (CHARGING confirms, FULL counts as charge-confirmed),
  then the signed current against
  `adapter_status.battery.charge_current_threshold_a` (sign flip via
  `adapter_status.battery.current_sign`), then the SOC trend
  (`adapter_status.battery.soc_trend_*`: ≥ min_delta % over the window). The
  trend is consulted only when the BMS exposes no status.
- `charger_connected`-equivalent state is derived from the BMS status
  (CHARGING / FULL / NOT_CHARGING mean the charger is connected).
- The read is fail-closed: an absent or broken power-supply device degrades
  back to the SOC-only behavior (electrical fields NaN/UNKNOWN) instead of
  erroring, and every merged field carries a `*_known` flag internally.

Standard ROS consumers should use:

- `/battery_state` (`sensor_msgs/msg/BatteryState`): BMS voltage/current/
  temperature/status/health with the merged percentage; `percentage` is NaN
  when no source is available, rather than reporting a fake 0%. Physical
  `present` is tracked separately, so an old percentage never makes a known
  installed battery appear absent;
- `/diagnostics` (`diagnostic_msgs/msg/DiagnosticArray`): connection, sample
  freshness, battery (including `battery_status`, `battery_status_source`,
  `battery_charging`, `charger_connected`, raw `battery_current_a` for
  verifying `current_sign`), mode/posture, authority owner, last SDK result,
  and last adapter error, grouped under `omni/robot_adapter`.

Simple transient-local compatibility topics are also published at
`/omni/robot/connection`, `/omni/robot/mode`, `/omni/robot/sdk_error`, and
`/omni/robot/adapter_status`. VBot currently has command services but no
authoritative chassis telemetry API, so its connection, battery percentage,
mode, and posture remain explicitly `unknown` (physical battery presence is
known). Requesting the `vbot` or `zsibot` product
adapter when it was not compiled into the binary now rejects process startup;
only an explicit `adapter=unavailable` diagnostic placeholder is permitted,
and it reports ERROR. These status topics are observational only and are
deliberately separate from the Safety Supervisor latch and reset protocol.
The `/omni/cmd_vel/arbiter_status` string is also republished at least once per
second with a monotonically increasing `status_seq`; consumers must treat a
non-advancing sequence as stale instead of trusting the transient-local cache.
Adapter errors are tracked by independent domains (telemetry, battery, motion,
stop, release, locomotion, posture, and authority): a successful connection
poll cannot erase an unresolved command or safety failure. Unknown firmware
posture/mode values remain WARN instead of being reported healthy.

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
Ownership is still relinquished if that fallback fails, but the callback and
diagnostics explicitly report a degraded release instead of claiming that the
safe posture was confirmed.
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
| App → robot | `/rosdeck/posture_command` | `std_msgs/msg/String` | `stand:<client_id>`, `lie_down:<client_id>`; ZsiBot requires `<client_id>` to own the current lease |
| Robot → app | `/rosdeck/posture_status` | `std_msgs/msg/String` | `success:*`, `error:*` |
| App → robot | `/rosdeck/locomotion_command` | `std_msgs/msg/String` | `loco:<client_id>`; ZsiBot requires `<client_id>` to own the current lease |
| Robot → app | `/rosdeck/locomotion_status` | `std_msgs/msg/String` | `success:loco`, `error:loco:*` |
| App → robot | `/rosdeck/control_command` | `std_msgs/msg/String` | `status:<id>`, `acquire:<id>`, `heartbeat:<id>`, `release:<id>` |
| Robot → app | `/rosdeck/control_status` | `std_msgs/msg/String` | `available`, `acquiring:<id>`, `acquired:<id>`, `releasing:<id>`, `cooldown:<seconds>`, `error:*` |
| Safety source → supervisor | `/omni/safety/estop_request` | `std_msgs/msg/Bool` | `true` latches; `false` never resets |
| Supervisor → Bridge | `/omni/safety/estop` | `std_msgs/msg/Bool` | Reliable heartbeat; `true` stop, `false` healthy/armed |
| Supervisor → observers | `/omni/safety/supervisor_status` | `std_msgs/msg/String` | Latch reason, heartbeat health and transition counters |
| Adapter → ROS | `/battery_state` | `sensor_msgs/msg/BatteryState` | Merged BMS+SDK: voltage/current/temperature/status/health from sysfs power_supply, percentage from SDK SOC (sysfs capacity fallback); NaN when no source is available |
| Adapter → ROS diagnostics | `/diagnostics` | `diagnostic_msgs/msg/DiagnosticArray` | Connection, freshness, battery, mode, authority and SDK errors |
| Adapter → simple observers | `/omni/robot/adapter_status` | `std_msgs/msg/String` | Compact cached adapter snapshot; never a safety reset signal |

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

The uninstaller disables the service and removes the generated units and
init hook. The profile-specific install directory is retained so the
installation can be recovered or inspected. In an A/B install the release
slots under `<install-prefix>/releases/` are left as well; remove individual
slots with `rm -rf <install-prefix>/releases/<id>` — never the slot that
`current` points at while the service is still running.
