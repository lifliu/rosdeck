# Rosdeck robot bridge

The Android app cannot execute a file on the robot through Foxglove directly.
Run the fixed-command ROS 2 bridge on the robot to enable the **3D Mapping**
button without exposing a remote shell.

```bash
source /opt/ros/humble/setup.bash
python3 rosdeck_mapping_bridge.py
```

The bridge listens for `std_msgs/msg/Empty` on
`/rosdeck/start_3d_mapping`, starts the fixed script
`/userdata/2_slam/1_mapping.sh`, and reports status as
`std_msgs/msg/String` on `/rosdeck/mapping_status`. Script output is written
to `/tmp/rosdeck_3d_mapping.log`.

For production, copy the script to a persistent directory on the robot and
start it from the robot's normal process supervisor after the ROS 2 environment
has been sourced.
