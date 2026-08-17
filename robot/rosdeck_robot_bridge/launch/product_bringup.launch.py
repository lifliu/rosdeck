"""Product bringup for the unified Gateway, safety supervisor, and docking.

OpenNav Docking's server publishes a relative ``cmd_vel`` topic.  When enabled
here, that output is remapped into the Gateway's dedicated docking input; it is
never allowed to publish the SDK-facing final command directly.
"""

import os

from ament_index_python.packages import (
    PackageNotFoundError,
    get_package_prefix,
    get_package_share_directory,
)
from launch import LaunchDescription
from launch.actions import (
    DeclareLaunchArgument,
    GroupAction,
    IncludeLaunchDescription,
    OpaqueFunction,
    Shutdown,
)
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node, SetRemap


DOCKING_INPUT_TOPIC = "/omni/cmd_vel/docking"


def _as_bool(value, argument_name):
    normalized = value.strip().lower()
    if normalized in ("1", "true", "yes", "on"):
        return True
    if normalized in ("0", "false", "no", "off"):
        return False
    raise RuntimeError(f"{argument_name} must be a boolean, got: {value!r}")


def _launch_optional_docking(context):
    if not _as_bool(
        LaunchConfiguration("use_opennav_docking").perform(context),
        "use_opennav_docking",
    ):
        return []

    params_file = LaunchConfiguration("docking_params_file").perform(context)
    if not params_file:
        raise RuntimeError(
            "use_opennav_docking=true requires docking_params_file to reference "
            "a robot-specific OpenNav Docking parameter YAML"
        )
    if not os.path.isabs(params_file):
        raise RuntimeError("docking_params_file must be an absolute path")
    if not os.path.isfile(params_file):
        raise RuntimeError(f"OpenNav Docking parameter file does not exist: {params_file}")

    cmd_vel_source = LaunchConfiguration("docking_cmd_vel_source").perform(context)
    if not cmd_vel_source or cmd_vel_source.startswith("/"):
        raise RuntimeError(
            "docking_cmd_vel_source must be the relative OpenNav output name "
            "(normally 'cmd_vel'), not an absolute topic"
        )

    required_executables = (
        ("opennav_docking", "opennav_docking"),
        ("nav2_lifecycle_manager", "lifecycle_manager"),
    )
    for required_package, executable_name in required_executables:
        try:
            package_prefix = get_package_prefix(required_package)
        except PackageNotFoundError as error:
            raise RuntimeError(
                "use_opennav_docking=true requires the runtime package "
                f"'{required_package}' in the sourced ROS overlay"
            ) from error
        executable_path = os.path.join(
            package_prefix, "lib", required_package, executable_name
        )
        if not os.path.isfile(executable_path) or not os.access(executable_path, os.X_OK):
            raise RuntimeError(
                "required Docking executable is missing or not executable: "
                f"{executable_path}"
            )

    use_sim_time = _as_bool(
        LaunchConfiguration("use_sim_time").perform(context), "use_sim_time"
    )
    autostart = _as_bool(
        LaunchConfiguration("docking_autostart").perform(context),
        "docking_autostart",
    )

    return [
        GroupAction(
            actions=[
                SetRemap(src=cmd_vel_source, dst=DOCKING_INPUT_TOPIC),
                Node(
                    package="opennav_docking",
                    executable="opennav_docking",
                    name="docking_server",
                    output="screen",
                    parameters=[params_file, {"use_sim_time": use_sim_time}],
                    on_exit=Shutdown(reason="OpenNav docking server exited"),
                ),
                Node(
                    package="nav2_lifecycle_manager",
                    executable="lifecycle_manager",
                    name="lifecycle_manager_docking",
                    output="screen",
                    parameters=[
                        {
                            "autostart": autostart,
                            "node_names": ["docking_server"],
                            "use_sim_time": use_sim_time,
                            }
                        ],
                    on_exit=Shutdown(reason="Docking lifecycle manager exited"),
                ),
            ]
        )
    ]


def generate_launch_description():
    share = get_package_share_directory("rosdeck_robot_bridge")
    bridge_launch = os.path.join(share, "launch", "bridge.launch.py")
    default_config = os.path.join(share, "config", "zsibot.yaml")

    config = LaunchConfiguration("config")
    bridge_node_name = LaunchConfiguration("bridge_node_name")
    enable_safety_supervisor = LaunchConfiguration("enable_safety_supervisor")
    return LaunchDescription(
        [
            DeclareLaunchArgument("config", default_value=default_config),
            DeclareLaunchArgument(
                "bridge_node_name", default_value="rosdeck_robot_bridge"
            ),
            # ZsiBot product deployments keep this true. Legacy VBot profiles
            # may pass false because their adapter has no cmd_vel arbiter; a
            # ZsiBot Bridge still refuses motion without its required monitor.
            DeclareLaunchArgument("enable_safety_supervisor", default_value="true"),
            DeclareLaunchArgument("use_opennav_docking", default_value="false"),
            DeclareLaunchArgument("docking_params_file", default_value=""),
            DeclareLaunchArgument("docking_cmd_vel_source", default_value="cmd_vel"),
            DeclareLaunchArgument("docking_autostart", default_value="true"),
            DeclareLaunchArgument("use_sim_time", default_value="false"),
            IncludeLaunchDescription(
                PythonLaunchDescriptionSource(bridge_launch),
                launch_arguments={
                    "config": config,
                    "bridge_node_name": bridge_node_name,
                    "enable_safety_supervisor": enable_safety_supervisor,
                }.items(),
            ),
            OpaqueFunction(function=_launch_optional_docking),
        ]
    )
