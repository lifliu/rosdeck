#!/usr/bin/env python3
"""ROS 2 bridge for Rosdeck's fixed 3D SLAM mapping command.

The node intentionally accepts no command text from the network. A message on
``/rosdeck/start_3d_mapping`` can only launch the fixed mapping script below.
"""

import os
import subprocess
import threading
from pathlib import Path

import rclpy
from rclpy.node import Node
from std_msgs.msg import Empty, String


SCRIPT_PATH = Path('/userdata/2_slam/1_mapping.sh')
LOG_PATH = Path('/tmp/rosdeck_3d_mapping.log')


class MappingBridge(Node):
    def __init__(self) -> None:
        super().__init__('rosdeck_mapping_bridge')
        self._lock = threading.Lock()
        self._process: subprocess.Popen[bytes] | None = None
        self._mapping_started = False
        self._status = self.create_publisher(String, '/rosdeck/3d_mapping_status', 10)
        self.create_subscription(Empty, '/rosdeck/start_3d_mapping', self._start_mapping, 10)
        self.get_logger().info(
            f'Ready: /rosdeck/start_3d_mapping launches {SCRIPT_PATH}'
        )

    def _publish_status(self, value: str) -> None:
        message = String()
        message.data = value
        self._status.publish(message)

    def _start_mapping(self, _message: Empty) -> None:
        with self._lock:
            if self._mapping_started:
                self.get_logger().warning('Mapping script is already running')
                self._publish_status('already_running')
                return

            if not SCRIPT_PATH.is_file():
                error = f'script_not_found:{SCRIPT_PATH}'
                self.get_logger().error(error)
                self._publish_status(f'error:{error}')
                return

            try:
                log_file = LOG_PATH.open('ab', buffering=0)
                self._process = subprocess.Popen(
                    ['/bin/bash', str(SCRIPT_PATH)],
                    stdin=subprocess.DEVNULL,
                    stdout=log_file,
                    stderr=subprocess.STDOUT,
                    cwd=str(SCRIPT_PATH.parent),
                    start_new_session=True,
                    env=os.environ.copy(),
                )
            except OSError as exc:
                error = f'launch_failed:{exc}'
                self.get_logger().error(error)
                self._publish_status(f'error:{error}')
                return

            pid = self._process.pid
            self._mapping_started = True
            self.get_logger().info(f'Started mapping script with PID {pid}')
            self._publish_status(f'started:{pid}')
            threading.Thread(target=self._wait_for_exit, args=(self._process,), daemon=True).start()

    def _wait_for_exit(self, process: subprocess.Popen[bytes]) -> None:
        return_code = process.wait()
        if return_code != 0:
            with self._lock:
                self._mapping_started = False
        self.get_logger().info(f'Mapping script PID {process.pid} exited with {return_code}')
        self._publish_status(f'exited:{return_code}')


def main() -> None:
    rclpy.init()
    node = MappingBridge()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
