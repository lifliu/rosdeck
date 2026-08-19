"""omni_mission_manager: dispatches and controls inspection missions (V1).

The pure-Python core (constants, route_store, event_store, state_machine,
checkpoints, segments, checkpoint_runner) has no ROS imports so it is
unit-testable off the robot. The rclpy wiring lives in
mission_manager_node.
"""

__version__ = "1.2.0"