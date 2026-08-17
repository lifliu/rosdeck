from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, Shutdown
from launch.conditions import IfCondition
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    config = LaunchConfiguration('config')
    bridge_node_name = LaunchConfiguration('bridge_node_name')
    enable_safety_supervisor = LaunchConfiguration('enable_safety_supervisor')
    return LaunchDescription([
        DeclareLaunchArgument('config'),
        DeclareLaunchArgument('bridge_node_name', default_value='rosdeck_robot_bridge'),
        DeclareLaunchArgument('enable_safety_supervisor', default_value='true'),
        Node(
            package='rosdeck_robot_bridge',
            executable='rosdeck_safety_supervisor_node',
            name='rosdeck_safety_supervisor',
            output='screen',
            parameters=[config],
            condition=IfCondition(enable_safety_supervisor),
            # A critical child exit must terminate the complete launch.  The
            # systemd unit restarts the entire safety boundary as one epoch.
            on_exit=Shutdown(reason='safety supervisor exited'),
        ),
        Node(
            package='rosdeck_robot_bridge',
            executable='rosdeck_robot_bridge_node',
            name=bridge_node_name,
            output='screen',
            parameters=[config],
            on_exit=Shutdown(reason='robot bridge exited'),
        ),
    ])
