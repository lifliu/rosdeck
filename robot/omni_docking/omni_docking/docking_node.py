"""omni_docking node: rclpy wiring around the pure DockingCore.

Wires the core to the real world:

  in : /omni/robot_state (RobotState, transient_local)
       <pose_topic> (nav_msgs/Odometry, global frame)
       /battery_state (sensor_msgs/BatteryState)
       /rosdeck/control_status (std_msgs/String)
  out: /omni/cmd_vel/docking (geometry_msgs/Twist, 20 Hz while an op is
       active; the UNIQUE publisher of this arbiter input)
       /omni/docking/status (DockStatus, transient_local, 1 Hz)
       /rosdeck/control_command (std_msgs/String, acquire/heartbeat/
       release with client id "docking-<request_id>")
  srv: /omni/docking/verify_charge (VerifyCharge)
       /omni/docking/config (GetDockConfig)
  act: /omni/docking/dock (Dock)
       /omni/docking/undock (Undock)

The default executor is single-threaded, so subscription callbacks,
timers, services and action callbacks all run sequentially on one
thread: no locks are needed, and the async execute callbacks keep the
20 Hz servo timer alive while they await the core's terminal event.

Control authority uses the gateway's Phase-0 string protocol
(/rosdeck/control_command | /rosdeck/control_status). The typed
ControlAuthority service is declared in the IDL but has no provider in
this repository yet; see authority.py.
"""

import asyncio
import math
import signal
import time

import rclpy
from geometry_msgs.msg import Twist
from nav_msgs.msg import Odometry
from rclpy.action import ActionServer
from rclpy.node import Node
from rclpy.qos import (DurabilityPolicy, QoSProfile, ReliabilityPolicy)
from sensor_msgs.msg import BatteryState
from std_msgs.msg import String

from omni_robot_interfaces.action import Dock, Undock
from omni_robot_interfaces.msg import DockStatus, RobotState
from omni_robot_interfaces.srv import GetDockConfig, VerifyCharge

from . import authority
from . import constants as C
from .charge_monitor import (
    BatterySample, ChargeMonitor, DEFAULT_CHARGE_CURRENT_A)
from .dock_config import DockConfigError, DockConfigStore
from .docking_core import (DockSnapshot, DockingCore, OP_DOCK, OP_UNDOCK)


def _param_str(node, name, default):
    v = node.get_parameter(name).value
    return default if v is None else str(v)


def _param_float(node, name, default):
    v = node.get_parameter(name).value
    return default if v is None else float(v)


def _quaternion_to_yaw(q):
    return math.atan2(
        2.0 * (q.w * q.x + q.y * q.z),
        1.0 - 2.0 * (q.y * q.y + q.z * q.z))


class DockingNode(Node):
    def __init__(self):
        super().__init__("omni_docking")

        # ---- parameters ------------------------------------------------
        self._docks_dir = _param_str(self, "docks_dir", "/var/lib/omni/docks")
        self._map_frame = _param_str(self, "map_frame", "lio_map")
        self._pose_topic = _param_str(
            self, "pose_topic", "/state_estimation_global")
        robot_state_topic = _param_str(
            self, "robot_state_topic", "/omni/robot_state")
        battery_topic = _param_str(self, "battery_topic", "/battery_state")
        self._control_command_topic = _param_str(
            self, "control_command_topic", "/rosdeck/control_command")
        control_status_topic = _param_str(
            self, "control_status_topic", "/rosdeck/control_status")
        cmd_vel_topic = _param_str(
            self, "cmd_vel_docking_topic", "/omni/cmd_vel/docking")
        status_topic = _param_str(
            self, "status_topic", "/omni/docking/status")
        dock_action = _param_str(self, "dock_action", "/omni/docking/dock")
        undock_action = _param_str(
            self, "undock_action", "/omni/docking/undock")
        verify_service = _param_str(
            self, "verify_charge_service", "/omni/docking/verify_charge")
        config_service = _param_str(
            self, "config_service", "/omni/docking/config")

        servo_rate = _param_float(self, "servo_rate_hz", 20.0)
        self._robot_state_stale_ms = _param_float(
            self, "robot_state_stale_ms", 2000.0)
        self._pose_stale_ms = _param_float(self, "pose_stale_ms", 500.0)
        approach_timeout = _param_float(self, "approach_timeout_sec", 45.0)
        move_timeout = _param_float(self, "move_timeout_sec", 45.0)
        charge_window = _param_float(self, "charge_window_sec", 30.0)
        pose_start_timeout = _param_float(
            self, "pose_start_timeout_sec", 5.0)
        pose_stale_sec = _param_float(self, "pose_stale_sec", 1.0)
        state_stale_sec = _param_float(self, "state_stale_sec", 2.0)
        standoff_speed = _param_float(self, "standoff_speed", 0.15)
        final_speed = _param_float(self, "final_speed", 0.05)
        pos_tolerance = _param_float(self, "pos_tolerance", 0.15)
        yaw_tolerance = _param_float(self, "yaw_tolerance", 0.25)
        charge_current_a = _param_float(
            self, "charge_current_a", DEFAULT_CHARGE_CURRENT_A)
        charge_current_sign = _param_float(
            self, "charge_current_sign", 1.0)

        # ---- core ------------------------------------------------------
        self._store = DockConfigStore(self._docks_dir)
        try:
            n, errors = self._store.load(strict=False)
            for map_id, msg in errors:
                self.get_logger().error(
                    "dock config {!r} unreadable: {}".format(map_id, msg))
            self.get_logger().info(
                "dock config: {} entr(y/ies) from {}".format(
                    n, self._docks_dir or "(not set)"))
        except Exception as exc:  # fail closed: no docks, diagnosable
            self.get_logger().error("dock config load failed: {}".format(exc))

        self._charge = ChargeMonitor(
            charge_current_a=charge_current_a,
            charge_current_sign=charge_current_sign)

        self._core = DockingCore(self._store, self._charge, {
            "approach_timeout_sec": approach_timeout,
            "move_timeout_sec": move_timeout,
            "charge_window_sec": charge_window,
            "pose_start_timeout_sec": pose_start_timeout,
            "pose_stale_sec": pose_stale_sec,
            "state_stale_sec": state_stale_sec,
            "standoff_speed": standoff_speed,
            "final_speed": final_speed,
            "pos_tolerance": pos_tolerance,
            "yaw_tolerance": yaw_tolerance,
        })

        # ---- latest sensor state (single executor thread, no locks) ----
        self._robot_state = None
        self._robot_state_at = None
        self._pose = None
        self._pose_at = None
        self._control_status = ""
        self._warned_frame = False

        # ---- publishers / subscriptions --------------------------------
        reliable_tl = QoSProfile(
            depth=1, reliability=ReliabilityPolicy.RELIABLE,
            durability=DurabilityPolicy.TRANSIENT_LOCAL)
        reliable = QoSProfile(
            depth=10, reliability=ReliabilityPolicy.RELIABLE)

        self._cmd_pub = self.create_publisher(Twist, cmd_vel_topic, 10)
        self._status_pub = self.create_publisher(
            DockStatus, status_topic, reliable_tl)
        self._control_cmd_pub = self.create_publisher(
            String, self._control_command_topic, 10)

        self.create_subscription(
            RobotState, robot_state_topic, self._on_robot_state, reliable_tl)
        self.create_subscription(
            Odometry, self._pose_topic, self._on_pose, reliable)
        self.create_subscription(
            BatteryState, battery_topic, self._on_battery, reliable)
        self.create_subscription(
            String, control_status_topic, self._on_control_status, reliable)

        # ---- services ----------------------------------------------------
        self.create_service(
            VerifyCharge, verify_service, self._on_verify_charge)
        self.create_service(
            GetDockConfig, config_service, self._on_get_config)

        # ---- action servers ----------------------------------------------
        self._op_results = {}   # request_id -> (success, code, text, extra)
        self._goal_by_request = {}  # request_id -> (goal_handle, kind)
        self._last_fb = {}       # request_id -> (state, progress_rounded)
        self._dock_server = ActionServer(
            self, Dock, dock_action, execute_callback=self._dock_execute_cb)
        self._undock_server = ActionServer(
            self, Undock, undock_action,
            execute_callback=self._undock_execute_cb)

        # ---- timers --------------------------------------------------------
        self.create_timer(1.0 / servo_rate, self._servo_tick)
        self.create_timer(1.0, self._publish_status)

    # ------------------------------------------------------------------ #
    # subscriptions
    # ------------------------------------------------------------------ #

    def _on_robot_state(self, msg):
        self._robot_state = msg
        self._robot_state_at = time.monotonic()

    def _on_pose(self, msg):
        if (self._map_frame and msg.header.frame_id
                and msg.header.frame_id != self._map_frame):
            if not self._warned_frame:
                self._warned_frame = True
                self.get_logger().warn(
                    "pose topic frame {!r} != map_frame {!r}; docking "
                    "poses are assumed to be in the map frame".format(
                        msg.header.frame_id, self._map_frame))
        p = msg.pose.pose
        self._pose = (p.position.x, p.position.y,
                      _quaternion_to_yaw(p.orientation))
        self._pose_at = time.monotonic()

    def _on_battery(self, msg):
        self._charge.update(_battery_sample(msg))

    def _on_control_status(self, msg):
        self._control_status = msg.data

    # ------------------------------------------------------------------ #
    # snapshot / servo
    # ------------------------------------------------------------------ #

    def _build_snapshot(self):
        now = time.monotonic()
        rs = self._robot_state
        fresh = (rs is not None and self._robot_state_at is not None
                 and (now - self._robot_state_at) * 1000.0
                 <= self._robot_state_stale_ms)
        pose = None
        if self._pose is not None and self._pose_at is not None and \
                (now - self._pose_at) * 1000.0 <= self._pose_stale_ms:
            pose = self._pose
        return DockSnapshot(
            now=now,
            robot_fresh=fresh,
            estop_latched=bool(rs.estop_latched) if rs is not None else False,
            localization_state=int(rs.localization_state)
            if rs is not None else C.LOC_UNKNOWN,
            map_id=rs.map_id if rs is not None else "",
            map_version=rs.map_version if rs is not None else "",
            pose=pose,
            control_status=self._control_status,
        )

    def _publish_twist(self, linear, angular):
        t = Twist()
        t.linear.x = float(linear)
        t.angular.z = float(angular)
        self._cmd_pub.publish(t)

    def _send_control(self, payload):
        m = String()
        m.data = payload
        self._control_cmd_pub.publish(m)

    def _servo_tick(self):
        op = self._core.active
        client_id = op.client_id if op is not None else None
        request_id = op.request_id if op is not None else None
        snap = self._build_snapshot()
        ev = self._core.update(snap)
        if ev.twist is not None:
            self._publish_twist(*ev.twist)
        if ev.acquire and client_id is not None:
            self._send_control(authority.command(C.ACTION_ACQUIRE, client_id))
        if ev.heartbeat and client_id is not None:
            self._send_control(
                authority.command(C.ACTION_HEARTBEAT, client_id))
        if ev.release and client_id is not None:
            self._send_control(authority.command(C.ACTION_RELEASE, client_id))
        if ev.feedback and request_id is not None:
            self._maybe_publish_feedback(request_id, ev.feedback)
        if ev.terminal and request_id is not None:
            success, code, text, extra = ev.terminal
            self.get_logger().info(
                "docking op {!r} terminal: {} ({})".format(
                    request_id, text, C.dock_reason_name(code)
                    if op is not None and op.kind == OP_DOCK
                    else C.undock_reason_name(code)))
            self._op_results[request_id] = (success, code, text, extra)
            self._core.finish()

    # ------------------------------------------------------------------ #
    # action callbacks
    # ------------------------------------------------------------------ #

    async def _dock_execute_cb(self, goal_handle):
        return await self._run_op(
            goal_handle, OP_DOCK, self._make_dock_result)

    async def _undock_execute_cb(self, goal_handle):
        return await self._run_op(
            goal_handle, OP_UNDOCK, self._make_undock_result)

    async def _run_op(self, goal_handle, kind, make_result):
        request_id = goal_handle.request.request_id
        self._goal_by_request[request_id] = (goal_handle, kind)
        try:
            snap = self._build_snapshot()
            ok, code, text = self._core.start(kind, request_id, snap)
            if not ok:
                self.get_logger().info(
                    "{} goal {!r} rejected: {} ({})".format(
                        kind, request_id, text, code))
                goal_handle.abort()
                return make_result(goal_handle, False, code, text)

            canceled_by_user = False
            while rclpy.ok():
                res = self._op_results.get(request_id)
                if res is not None:
                    break
                # ServerGoalHandle.is_cancel_requested is a METHOD (a bare
                # attribute read is a truthy bound method).
                if goal_handle.is_cancel_requested():
                    self._core.request_cancel(request_id)
                    canceled_by_user = True
                await asyncio.sleep(0.1)

            res = self._op_results.pop(request_id, None)
            if res is None:
                # rclpy is shutting down: make a clean terminal answer.
                self._core.request_cancel(request_id)
                res = (False, C.REASON_ABORTED, "node shutting down", {})
            success, code, text, extra = res
            if canceled_by_user and code == C.REASON_USER_CANCELED:
                goal_handle.canceled()
            elif success:
                goal_handle.succeed()
            else:
                goal_handle.abort()
            return make_result(goal_handle, success, code, text, extra)
        finally:
            self._goal_by_request.pop(request_id, None)
            self._last_fb.pop(request_id, None)

    def _maybe_publish_feedback(self, request_id, feedback):
        state, progress, text = feedback
        key = (state, int(round(progress * 20)))
        if self._last_fb.get(request_id) == key:
            return
        self._last_fb[request_id] = key
        entry = self._goal_by_request.get(request_id)
        if entry is None:
            return
        goal_handle, kind = entry
        fb_type = Dock.Feedback if kind == OP_DOCK else Undock.Feedback
        fb = fb_type()
        fb.state = state
        fb.progress = progress
        fb.status_text = text
        goal_handle.publish_feedback(fb)

    def _make_dock_result(self, goal_handle, success, code, text,
                          extra=None):
        extra = extra or {}
        r = Dock.Result()
        r.success = success
        r.reason_code = code
        r.reason_text = text
        r.charging = bool(extra.get("charging", False))
        return r

    def _make_undock_result(self, goal_handle, success, code, text,
                            extra=None):
        extra = extra or {}
        r = Undock.Result()
        r.success = success
        r.reason_code = code
        r.reason_text = text
        r.clearance_m = float(extra.get("clearance_m", 0.0))
        return r

    # ------------------------------------------------------------------ #
    # services
    # ------------------------------------------------------------------ #

    def _on_verify_charge(self, request, response):
        verdict = self._charge.verify(
            time.monotonic(), max_age_sec=request.max_age_sec)
        response.ok = verdict.ok
        response.charging = verdict.charging
        response.voltage = verdict.voltage
        response.percentage = verdict.percentage
        response.current = verdict.current
        response.message = verdict.message
        return response

    def _on_get_config(self, request, response):
        try:
            self._store.load(strict=False)
        except DockConfigError as exc:
            response.found = False
            response.message = "dock config unreadable: {}".format(exc)
            return response
        cfg = self._store.look_up(request.map_id, request.map_version)
        if cfg is None:
            response.found = False
            response.message = "no dock configured for map {!r} version " \
                "{!r}".format(request.map_id, request.map_version)
            return response
        response.found = True
        response.dock_id = cfg.dock_id
        response.pose_x = cfg.pose.x
        response.pose_y = cfg.pose.y
        response.pose_yaw = cfg.pose.yaw
        response.approach_distance = cfg.pose.approach_distance
        response.message = "ok"
        return response

    # ------------------------------------------------------------------ #
    # status
    # ------------------------------------------------------------------ #

    def _publish_status(self):
        snap = self._build_snapshot()
        view = self._core.status_view(snap)
        msg = DockStatus()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.header.frame_id = self._map_frame
        msg.state = view["state"]
        msg.dock_id = view["dock_id"]
        msg.map_id = view["map_id"]
        msg.map_version = view["map_version"]
        msg.charging = view["charging"]
        msg.battery_percentage = view["battery_percentage"]
        msg.dock_pose_error_m = view["dock_pose_error_m"]
        msg.last_reason_code = view["last_reason_code"]
        msg.last_reason_text = view["last_reason_text"]
        self._status_pub.publish(msg)

    # ------------------------------------------------------------------ #
    # shutdown
    # ------------------------------------------------------------------ #

    def shutdown(self):
        """Zero the velocity and release the lease before node teardown."""
        op = self._core.active
        try:
            if op is not None:
                self._core.request_cancel(op.request_id)
                ev = self._core.update(self._build_snapshot())
                self._publish_twist(0.0, 0.0)
                if ev is not None and ev.release:
                    self._send_control(
                        authority.command(C.ACTION_RELEASE, op.client_id))
            else:
                self._publish_twist(0.0, 0.0)
        except Exception as exc:
            self.get_logger().warn(
                "shutdown release failed: {}".format(exc))


def _battery_sample(msg):
    from .charge_monitor import BatterySample
    # sensor_msgs/BatteryState has no power field; the BMS status carried
    # on power_supply_status is the authoritative charge confirmation.
    return BatterySample(
        voltage=msg.voltage,
        percentage=msg.percentage,
        current=msg.current if msg.current is not None else float("nan"),
        power_supply_status=int(msg.power_supply_status),
        stamp=time.monotonic())


def _handle_sigterm(signum, frame):
    # Unwind rclpy.spin() so the finally-block runs node.shutdown().
    raise KeyboardInterrupt


def main(args=None):
    rclpy.init(args=args)
    signal.signal(signal.SIGTERM, _handle_sigterm)
    node = DockingNode()
    try:
        rclpy.spin(node)
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        node.shutdown()
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()