#!/usr/bin/env python3
"""ROS 2 bridge for Rosdeck's fixed mapping and posture commands.

The node intentionally exposes only a small allowlist of commands. Mapping can
only launch the fixed script below, while posture commands are translated to
the robot's ``software_msgs/srv/LowlevelAction`` service.
"""

import os
import signal
import subprocess
import threading
import uuid
from pathlib import Path

import rclpy
from rclpy.node import Node
from std_msgs.msg import Bool, String

try:
    from software_msgs.srv import LowlevelAction
except ImportError:
    LowlevelAction = None  # type: ignore[assignment,misc]


SCRIPT_PATH = Path('/userdata/2_slam/1_mapping.sh')
LOG_PATH = Path('/tmp/rosdeck_3d_mapping.log')
LOWLEVEL_ACTION_TYPE = 'software_msgs/srv/LowlevelAction'
POSTURE_MODES = {
    'stand': 1,     # LowlevelAction.Request.FIXED_STAND
    'lie_down': 2,  # LowlevelAction.Request.FIXED_LAYDOWN
}


class MappingBridge(Node):
    def __init__(self) -> None:
        super().__init__('rosdeck_mapping_bridge')
        self._lock = threading.Lock()
        self._process: subprocess.Popen[bytes] | None = None
        self._stop_requested = False
        self._status = self.create_publisher(String, '/rosdeck/mapping_status', 10)
        self._posture_status = self.create_publisher(String, '/rosdeck/posture_status', 10)
        self._posture_busy = False
        self._lowlevel_action_client = None
        self.create_subscription(
            Bool, '/rosdeck/start_3d_mapping', self._handle_mapping_command, 10
        )
        self.create_subscription(String, '/rosdeck/posture_command', self._set_posture, 10)
        self.get_logger().info(
            f'Ready: /rosdeck/start_3d_mapping starts/stops {SCRIPT_PATH}'
        )
        self.get_logger().info(
            'Ready: /rosdeck/posture_command accepts stand or lie_down'
        )

    def _publish_status(self, value: str) -> None:
        message = String()
        message.data = value
        self._status.publish(message)

    def _publish_posture_status(self, value: str) -> None:
        message = String()
        message.data = value
        self._posture_status.publish(message)

    def _get_lowlevel_action_client(self):
        if LowlevelAction is None:
            return None
        if self._lowlevel_action_client is not None:
            return self._lowlevel_action_client

        for service_name, service_types in self.get_service_names_and_types():
            if LOWLEVEL_ACTION_TYPE in service_types:
                self._lowlevel_action_client = self.create_client(
                    LowlevelAction, service_name
                )
                self.get_logger().info(
                    f'Discovered LowlevelAction service: {service_name}'
                )
                return self._lowlevel_action_client
        return None

    def _set_posture(self, message: String) -> None:
        command = message.data.strip().lower()
        mode = POSTURE_MODES.get(command)
        if mode is None:
            self.get_logger().warning(f'Ignoring unsupported posture: {command!r}')
            self._publish_posture_status(f'error:{command}:unsupported_command')
            return
        if self._posture_busy:
            self._publish_posture_status(f'error:{command}:action_in_progress')
            return

        client = self._get_lowlevel_action_client()
        if client is None:
            reason = (
                'software_msgs_not_installed'
                if LowlevelAction is None
                else 'lowlevel_action_service_not_found'
            )
            self.get_logger().error(reason)
            self._publish_posture_status(f'error:{command}:{reason}')
            return
        if not client.wait_for_service(timeout_sec=1.0):
            self.get_logger().error('LowlevelAction service is not ready')
            self._publish_posture_status(f'error:{command}:service_not_ready')
            return

        request = LowlevelAction.Request()
        request.target_state = 1
        request.mode = mode
        request.req_id = f'rosdeck-{uuid.uuid4().hex}'
        request.pre_check = False
        request.action_path = ''
        request.action_params_json = '{}'

        self._posture_busy = True
        self.get_logger().info(f'Requesting posture: {command} (mode={mode})')
        future = client.call_async(request)
        future.add_done_callback(
            lambda completed, requested=command: self._posture_done(
                requested, completed
            )
        )

    def _posture_done(self, command: str, future) -> None:
        self._posture_busy = False
        try:
            response = future.result()
        except Exception as exc:  # noqa: BLE001 - ROS future may raise middleware errors
            self.get_logger().error(f'Posture {command} failed: {exc}')
            self._publish_posture_status(f'error:{command}:service_call_failed')
            return

        if response.success:
            self.get_logger().info(f'Posture {command} completed')
            self._publish_posture_status(f'success:{command}')
        else:
            reason = response.message or f'error_code_{response.error_code}'
            reason = reason.replace(':', '_')
            self.get_logger().error(f'Posture {command} rejected: {reason}')
            self._publish_posture_status(f'error:{command}:{reason}')

    def _handle_mapping_command(self, message: Bool) -> None:
        if message.data:
            self._start_mapping()
        else:
            self._stop_mapping()

    def _start_mapping(self) -> None:
        with self._lock:
            if self._process is not None and self._process.poll() is None:
                self.get_logger().warning('Mapping script is already running')
                self._publish_status('already_running')
                return

            self._process = None

            if not SCRIPT_PATH.is_file():
                error = f'script_not_found:{SCRIPT_PATH}'
                self.get_logger().error(error)
                self._publish_status(f'error:{error}')
                return

            try:
                with LOG_PATH.open('ab', buffering=0) as log_file:
                    self._process = subprocess.Popen(
                        ['/bin/bash', str(SCRIPT_PATH)],
                        stdin=subprocess.DEVNULL,
                        stdout=log_file,
                        stderr=subprocess.STDOUT,
                        cwd=str(SCRIPT_PATH.parent),
                        # Make the shell the leader of a new process group. A
                        # later SIGINT then reaches ros2 launch and every child,
                        # exactly like Ctrl+C in the original terminal.
                        start_new_session=True,
                        env=os.environ.copy(),
                    )
            except OSError as exc:
                error = f'launch_failed:{exc}'
                self.get_logger().error(error)
                self._publish_status(f'error:{error}')
                return

            pid = self._process.pid
            self._stop_requested = False
            self.get_logger().info(f'Started mapping script with PID {pid}')
            self._publish_status(f'started:{pid}')
            threading.Thread(target=self._wait_for_exit, args=(self._process,), daemon=True).start()

    def _stop_mapping(self) -> None:
        with self._lock:
            process = self._process
            if process is None or process.poll() is not None:
                self._process = None
                self._stop_requested = False
                self.get_logger().warning('Mapping script is not running')
                self._publish_status('not_running')
                return

            self._stop_requested = True
            try:
                os.killpg(process.pid, signal.SIGINT)
            except OSError as exc:
                self._stop_requested = False
                error = f'stop_failed:{exc}'
                self.get_logger().error(error)
                self._publish_status(f'error:{error}')
                return

            self.get_logger().info(
                f'Sent SIGINT to mapping process group {process.pid}; waiting for map save'
            )
            self._publish_status(f'stopping:{process.pid}')

    def _wait_for_exit(self, process: subprocess.Popen[bytes]) -> None:
        return_code = process.wait()
        with self._lock:
            stop_requested = self._stop_requested
            if self._process is process:
                self._process = None
                self._stop_requested = False
        self.get_logger().info(f'Mapping script PID {process.pid} exited with {return_code}')
        status = 'stopped' if stop_requested else 'exited'
        self._publish_status(f'{status}:{return_code}')

    def shutdown_mapping(self) -> None:
        """Gracefully stop mapping when this bridge itself is shutting down."""
        with self._lock:
            process = self._process
            if process is None or process.poll() is not None:
                return
            self._stop_requested = True
            try:
                os.killpg(process.pid, signal.SIGINT)
            except OSError as exc:
                self.get_logger().error(f'Failed to stop mapping during shutdown: {exc}')
                return

        self.get_logger().info('Waiting for mapping process to save the map')
        try:
            process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            self.get_logger().warning(
                'Mapping process is still saving after 30 seconds; it was not force-killed'
            )


def main() -> None:
    rclpy.init()
    node = MappingBridge()
    try:
        rclpy.spin(node)
    finally:
        node.shutdown_mapping()
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
