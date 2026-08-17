"""Bring up the Mission Manager (defaults match the production layout)."""

from launch import LaunchDescription
from launch_ros.actions import Node


def generate_launch_description():
    return LaunchDescription([
        Node(
            package="omni_mission_manager",
            executable="mission_manager_node",
            name="omni_mission_manager",
            output="screen",
        )
    ])