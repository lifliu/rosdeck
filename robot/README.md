# Rosdeck robot bridge

The Android app cannot execute a file on the robot through Foxglove directly.
Run the fixed-command ROS 2 bridge on the robot to enable the **3D Mapping**,
**Stand**, and **Lie Down** buttons without exposing a remote shell.

```bash
source /opt/ros/humble/setup.bash
python3 rosdeck_mapping_bridge.py
```

The bridge listens for `std_msgs/msg/Bool` on `/rosdeck/start_3d_mapping`.
`data: true` starts the fixed script `/userdata/2_slam/1_mapping.sh`;
`data: false` sends `SIGINT` to the complete mapping process group, matching a
terminal `Ctrl+C` so FAST-LIO can save `maps/map.pcd` before exiting. It reports status as
`std_msgs/msg/String` on `/rosdeck/mapping_status`. Script output is written
to `/tmp/rosdeck_3d_mapping.log`.

For posture control, the bridge accepts only `stand` and `lie_down` as
`std_msgs/msg/String` values on `/rosdeck/posture_command`. It automatically
discovers the robot's `software_msgs/srv/LowlevelAction` service and calls the
official `FIXED_STAND` (mode 1) or `FIXED_LAYDOWN` (mode 2) interface. Results
are published on `/rosdeck/posture_status`; arbitrary service names, modes, or
request fields cannot be supplied by the phone.

Confirm that the robot exposes the service before using the buttons:

```bash
ros2 service list -t | grep software_msgs/srv/LowlevelAction
```

For production, copy the script to a persistent directory on the robot and
start it from the robot's normal process supervisor after the ROS 2 environment
has been sourced.
