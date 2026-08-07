from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    config = LaunchConfiguration('config')
    return LaunchDescription([
        DeclareLaunchArgument('config'),
        Node(
            package='rosdeck_robot_bridge',
            executable='rosdeck_robot_bridge_node',
            name='rosdeck_robot_bridge',
            output='screen',
            parameters=[config],
        ),
    ])
