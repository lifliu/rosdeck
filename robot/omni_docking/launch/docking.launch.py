"""Bring up the docking controller (defaults match the production layout).

The node ships with production defaults; this file only adds the
optional parameter file for robot-specific tuning.
"""

import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch_ros.actions import Node


def generate_launch_description():
    params = os.path.join(
        get_package_share_directory("omni_docking"),
        "config", "docking_params.yaml")
    return LaunchDescription([
        Node(
            package="omni_docking",
            executable="docking_node",
            name="omni_docking",
            output="screen",
            parameters=[params],
        )
    ])