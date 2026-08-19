"""Mission Manager node (V1 + Phase 3 checkpoints) — rclpy wiring.

Wires MissionMachine (state_machine.py, pure Python) to ROS 2:

  - ExecuteInspection action server on /omni/mission/execute
  - DispatchMission service on /omni/mission/dispatch (App entry point;
    the foxglove/rosbridge WS bridges do not carry ROS 2 actions, so the
    App dispatches through this service; same state machine, gates and
    reason codes as the action)
  - MissionControl service on /omni/mission/control
  - ListRoutes service on /omni/routes/list
  - GetCheckpointResults service on /omni/mission/results (Phase 3; the
    durable view of /omni/mission/checkpoint_results)
  - ReturnToDock action server on /omni/mission/return_to_dock
    (Phase 3 return-to-dock; see below)
  - FollowRoute action client on /omni/navigation/follow_route
  - Dock action client on /omni/docking/dock (Phase 3 return-to-dock)
  - GetDockConfig service client on /omni/docking/config (Phase 3)
  - ControlAuthority client on /omni/control/authority (mission lease)
  - CapturePhoto / StartRecord / Recognize service clients (Phase 3; the
    camera/perception bridge on the Orin provides them)
  - RobotState subscription on /omni/robot_state (dispatch gates)
  - Odometry subscription on /state_estimation_global (return-to-dock
    nav-leg start point; the same topic omni_docking reads)
  - MissionStatus publisher on /omni/mission/status (transient_local)
  - MissionEvent publisher on /omni/mission/events (reliable)
  - CheckpointResult publisher on /omni/mission/checkpoint_results
    (reliable, transient_local; Phase 3)
  - SQLite event store + restart recovery (active -> INTERRUPTED,
    never auto-resumed)

Checkpoint execution (Phase 3): a route with a checkpoint sidecar is
walked leg by leg. Each leg is one FollowRoute goal over the sub-path
between two checkpoint points; the planner dedups mission ids, so each
leg sends a distinct id <mission_id>-s<leg>-a<attempt>. At a checkpoint
the robot stops and a worker thread runs its actions (dwell, photo,
record, recognize with retries); evidence is persisted to SQLite and
published as CheckpointResult. The worker is the only non-executor
thread and only ever takes the core lock for quick state reads — all
machine/store mutations and ROS publishes happen on the executor thread
except the per-record append (worker, under the core lock) and the
per-record publish (rclpy publishers are thread-safe).

Pause semantics: pausing releases the mission lease; the gateway
arbiter then outputs zero velocity (the robot stops cleanly) and
resuming re-acquires the lease. There is no action-protocol pause
primitive. A paused mission also holds its checkpoint worker: dwell time
does not elapse and retries are deferred until resume.

Return-to-dock (Phase 3): the ReturnToDock action server runs a two-leg
chain (return_to_dock.py, pure Python): (1) a FollowRoute leg from the
current pose (read from the Odometry subscription) to the dock's
standoff point, holding the MISSION lease under the client id
"mission-rtd-<san>"; (2) the /omni/docking/dock action, which acquires
its own DOCKING lease (the nav-leg lease is released first; the gateway
arbiter maps owners 1:1). A low-battery watchdog in the periodic check
triggers the same chain through the node's own ReturnToDock action
client (reusing one code path), at most once per episode: it re-arms
only when the robot is charging or the battery recovers above the
threshold + hysteresis, so a failed return never retries in a loop.
The chain is not a MissionMachine mission: no MissionEvent /
MissionStatus, only action feedback.
"""

import asyncio
import math
import signal
import threading
import time
from datetime import datetime, timezone

import rclpy
from rclpy.action import ActionClient, ActionServer, GoalStatus
from rclpy.duration import Duration
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy

from builtin_interfaces.msg import Time
from geometry_msgs.msg import Pose, PoseStamped, Quaternion
from nav_msgs.msg import Odometry, Path

from omni_robot_interfaces.action import (
    Dock,
    ExecuteInspection,
    FollowRoute,
    ReturnToDock,
)
from omni_robot_interfaces.msg import (
    CheckpointResult,
    MissionEvent,
    MissionStatus,
    RobotState,
)
from omni_robot_interfaces.srv import (
    CapturePhoto,
    ControlAuthority,
    DispatchMission,
    GetCheckpointResults,
    GetDockConfig,
    ListRoutes,
    MissionControl,
    Recognize,
    StartRecord,
)

from . import __version__
from . import constants as C
from .cancel_wait import wait_with_cancel
from .checkpoints import CheckpointStore
from .checkpoint_runner import CaptureOutcome, CheckpointRunner
from .event_store import EventStore
from .return_to_dock import (
    LowBatteryTrigger,
    RtdContext,
    ReturnToDockMachine,
    check_goal,
)
from .route_store import RouteStore
from .segments import (
    NEXT_CHECKPOINT,
    NEXT_DONE,
    NEXT_SEND,
    PHASE_CHECKPOINT,
    PHASE_MOVING,
    SegmentController,
)
from .state_machine import (
    DispatchGoal,
    MissionMachine,
    RobotStateView,
)


def _iso_utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _yaw_to_quaternion(yaw: float) -> Quaternion:
    q = Quaternion()
    q.x = 0.0
    q.y = 0.0
    q.z = math.sin(yaw / 2.0)
    q.w = math.cos(yaw / 2.0)
    return q


def _pose_tuple(ps) -> tuple:
    """(x, y, z, yaw) from a PoseStamped (yaw from the quaternion)."""
    o = ps.orientation
    yaw = math.atan2(
        2.0 * (o.w * o.z + o.x * o.y),
        1.0 - 2.0 * (o.y * o.y + o.z * o.z))
    return (ps.position.x, ps.position.y, ps.position.z, yaw)


def _build_path(frame_id, points) -> Path:
    """nav_msgs/Path for a list of (x, y, z) route points, yaw from the
    direction of travel (first/last points use their neighbor)."""
    path = Path()
    path.header.frame_id = frame_id or "lio_map"
    for i, (x, y, z) in enumerate(points):
        pose = PoseStamped()
        pose.header = path.header
        pose.position.x = x
        pose.position.y = y
        pose.position.z = z
        if i == 0 and len(points) > 1:
            dx = points[1][0] - points[0][0]
            dy = points[1][1] - points[0][1]
        elif i > 0:
            dx = points[i][0] - points[i - 1][0]
            dy = points[i][1] - points[i - 1][1]
        else:
            dx, dy = 1.0, 0.0
        yaw = math.atan2(dy, dx) if (dx or dy) else 0.0
        pose.orientation = _yaw_to_quaternion(yaw)
        path.poses.append(pose)
    return path


class MissionManagerNode(Node):
    def __init__(self):
        super().__init__("omni_mission_manager")

        # --- parameters (defaults are the production layout) ---
        self._routes_dir = self._param_str("routes_dir",
                                           "/var/lib/omni/routes")
        self._db_path = self._param_str(
            "database", "/var/lib/omni/mission_manager/missions.db")
        self._robot_state_topic = self._param_str(
            "robot_state_topic", "/omni/robot_state")
        self._status_topic = self._param_str(
            "status_topic", "/omni/mission/status")
        self._events_topic = self._param_str(
            "events_topic", "/omni/mission/events")
        self._results_topic = self._param_str(
            "results_topic", "/omni/mission/checkpoint_results")
        self._execute_action = self._param_str(
            "execute_action", "/omni/mission/execute")
        self._follow_route_action = self._param_str(
            "follow_route_action", "/omni/navigation/follow_route")
        self._control_service = self._param_str(
            "control_service", "/omni/mission/control")
        self._routes_service = self._param_str(
            "routes_service", "/omni/routes/list")
        self._dispatch_service = self._param_str(
            "dispatch_service", "/omni/mission/dispatch")
        self._results_service = self._param_str(
            "results_service", "/omni/mission/results")
        self._authority_service = self._param_str(
            "authority_service", "/omni/control/authority")
        self._capture_photo_service = self._param_str(
            "capture_photo_service", "/omni/capture/photo")
        self._capture_record_service = self._param_str(
            "capture_record_service", "/omni/capture/record")
        self._recognize_service = self._param_str(
            "recognize_service", "/omni/recognize")
        self._lease_sec = float(
            self.declare_parameter("lease_sec", 5.0).value)
        self._renew_period_sec = float(
            self.declare_parameter("lease_renew_period_sec", 1.0).value)
        self._robot_state_stale_ms = float(
            self.declare_parameter("robot_state_stale_ms", 2000.0).value)
        self._planner_stale_sec = float(
            self.declare_parameter("planner_stale_sec", 30.0).value)
        # Blocking perception waits (Phase 3). The record timeout covers
        # the full requested recording duration plus margin; the runner
        # aborts the wait early when the mission is canceled/aborted.
        self._capture_timeout_sec = float(
            self.declare_parameter("capture_timeout_sec", 120.0).value)
        self._record_timeout_sec = float(
            self.declare_parameter("record_timeout_sec", 660.0).value)
        # Return-to-dock (Phase 3).
        self._return_action = self._param_str(
            "return_action", "/omni/mission/return_to_dock")
        self._dock_action = self._param_str(
            "dock_action", "/omni/docking/dock")
        self._dock_config_service = self._param_str(
            "dock_config_service", "/omni/docking/config")
        # Current-pose topic for the nav-leg start point (the same
        # topic omni_docking reads).
        self._pose_topic = self._param_str(
            "pose_topic", "/state_estimation_global")
        # Low-battery watchdog: trigger a return-to-dock at or below
        # this percentage; <= 0 disables the watchdog.
        self._battery_low_return_pct = float(
            self.declare_parameter(
                "battery_low_return_pct", 20.0).value)

        # --- pure core ---
        self._store = EventStore(self._db_path)
        self._routes = RouteStore(self._routes_dir)
        self._checkpoints = CheckpointStore(self._routes)
        self._machine = MissionMachine(
            self._store, self._routes, now_fn=_iso_utc_now,
            checkpoint_store=self._checkpoints)
        # Serializes the core (machine + store + segment state) between
        # the rclpy executor thread and the checkpoint worker thread.
        # Never held across a blocking service call or sleep.
        self._core_lock = threading.RLock()
        # Return-to-dock chain (one at a time; see return_to_dock.py).
        self._rtd_machine = ReturnToDockMachine()
        self._lowbatt = LowBatteryTrigger(self._battery_low_return_pct)
        self._rtd_seq = 0  # low-battery request id counter

        # --- ROS wiring ---
        reliable_tl = QoSProfile(
            depth=1,
            reliability=ReliabilityPolicy.RELIABLE,
            durability=DurabilityPolicy.TRANSIENT_LOCAL)
        reliable = QoSProfile(
            depth=10, reliability=ReliabilityPolicy.RELIABLE)

        self._robot_state = None
        self._last_robot_state_at = None
        self.create_subscription(
            RobotState, self._robot_state_topic, self._on_robot_state,
            reliable_tl)

        # Current pose for the return-to-dock nav leg (RobotState
        # carries no pose; the planner needs a 2-point path and the
        # first point is where the robot is right now).
        self._pose = None
        self._last_pose_at = None
        self.create_subscription(
            Odometry, self._pose_topic, self._on_pose, reliable)

        self._status_pub = self.create_publisher(
            MissionStatus, self._status_topic, reliable_tl)
        self._events_pub = self.create_publisher(
            MissionEvent, self._events_topic, reliable)
        self._checkpoint_pub = self.create_publisher(
            CheckpointResult, self._results_topic, reliable_tl)

        self.create_service(
            MissionControl, self._control_service, self._on_mission_control)
        self.create_service(
            ListRoutes, self._routes_service, self._on_list_routes)
        self.create_service(
            DispatchMission, self._dispatch_service, self._on_dispatch)
        self.create_service(
            GetCheckpointResults, self._results_service,
            self._on_get_results)
        self._authority_client = self.create_client(
            ControlAuthority, self._authority_service)
        self._photo_client = self.create_client(
            CapturePhoto, self._capture_photo_service)
        self._record_client = self.create_client(
            StartRecord, self._capture_record_service)
        self._recognize_client = self.create_client(
            Recognize, self._recognize_service)

        self._execute_server = ActionServer(
            self, ExecuteInspection, self._execute_action,
            execute_callback=self._execute_cb)
        self._follow_client = ActionClient(
            self, FollowRoute, self._follow_route_action)

        # Return-to-dock (Phase 3): the server, plus the node's own
        # action client to it (the low-battery watchdog triggers the
        # same chain that a user goal takes), the Dock action client
        # and the dock-config service client.
        self._return_server = ActionServer(
            self, ReturnToDock, self._return_action,
            execute_callback=self._return_cb)
        self._rtd_client = ActionClient(
            self, ReturnToDock, self._return_action)
        self._dock_client = ActionClient(
            self, Dock, self._dock_action)
        self._dock_config_client = self.create_client(
            GetDockConfig, self._dock_config_service)

        # per-mission follow goal bookkeeping
        self._follow_handles = {}   # mission_id -> async GoalHandle
        self._follow_sent = set()   # mission_ids with a leg goal in flight
        self._last_feedback_at = {}  # mission_id -> monotonic seconds
        self._goal_terminal_since = {}  # mission_id -> monotonic seconds
        self._last_fb = {}          # mission_id -> (state, progress, cp)
        self._last_pose = {}        # mission_id -> (x, y, z, yaw) or None
        self._seg_ctrl = {}         # mission_id -> SegmentController

        # lease bookkeeping
        self._renew_for = None      # mission_id currently holding a lease
        self._renew_failures = 0

        # return-to-dock bookkeeping (one chain at a time)
        self._rtd_leg_id_ = ""      # "rtd-<san>": planner mission_id,
        # Dock goal request_id and the lease client id suffix
        self._rtd_map_id = ""
        self._rtd_map_version = ""
        self._rtd_standoff = None  # (x, y) dock standoff point
        self._rtd_lease_held = False  # nav-leg MISSION lease held
        self._rtd_renew_failures = 0
        self._rtd_nav_sent = False
        self._rtd_dock_sent = False
        self._rtd_follow_handle = None
        self._rtd_dock_handle = None
        self._rtd_last_nav_fb_at = 0.0
        self._rtd_terminal_since = None
        self._rtd_last_fb = None   # feedback dedup key

        self.create_timer(self._renew_period_sec, self._periodic_check)
        self.create_timer(1.0, self._publish_status)

        # --- restart recovery: publish recovered INTERRUPTED events ---
        recovered = self._machine.recover_on_startup()
        for m in recovered:
            self.get_logger().warning(
                "recovered active mission %s as INTERRUPTED (never "
                "auto-resumed)", m.mission_id)
        self._flush_events()
        self._publish_status()
        self.get_logger().info(
            "omni_mission_manager up: routes_dir=%s db=%s",
            self._routes_dir, self._db_path)

    def _param_str(self, name, default):
        return self.declare_parameter(name, default).value

    # ---------- RobotState ----------

    def _on_robot_state(self, msg):
        self._robot_state = msg
        self._last_robot_state_at = time.monotonic()

    def _on_pose(self, msg):
        self._pose = msg
        self._last_pose_at = time.monotonic()

    def _robot_view(self) -> RobotStateView:
        msg = self._robot_state
        if msg is None or self._last_robot_state_at is None:
            return RobotStateView(fresh=False)
        age_ms = (time.monotonic() - self._last_robot_state_at) * 1000.0
        fresh = age_ms <= self._robot_state_stale_ms
        return RobotStateView(
            fresh=fresh,
            localization_state=int(msg.localization_state),
            map_id=msg.map_id,
            map_version=msg.map_version)

    def _rtd_robot_view(self) -> RtdContext:
        """Robot facts for the return-to-dock goal gates (RobotState
        plus the pose subscription). RobotStateView is reused for
        dispatch; the RTD gates also need estop, charging and pose
        freshness, so this builds an RtdContext instead."""
        msg = self._robot_state
        fresh = False
        if msg is not None and self._last_robot_state_at is not None:
            age_ms = (time.monotonic() - self._last_robot_state_at) * 1000.0
            fresh = age_ms <= self._robot_state_stale_ms
        pose_fresh = False
        if self._pose is not None and self._last_pose_at is not None:
            pose_age_ms = (time.monotonic() - self._last_pose_at) * 1000.0
            pose_fresh = pose_age_ms <= self._robot_state_stale_ms
        with self._core_lock:
            mission_active = self._machine.active_mission() is not None
        return RtdContext(
            fresh=fresh,
            estop_latched=bool(msg.estop_latched) if msg is not None
            else False,
            charging=bool(msg.charging) if msg is not None else False,
            map_id=msg.map_id if msg is not None else "",
            map_version=msg.map_version if msg is not None else "",
            localization_state=int(msg.localization_state)
            if msg is not None else C.LOC_UNKNOWN,
            pose_fresh=pose_fresh,
            mission_active=mission_active)

    def _rtd_pose(self):
        """(x, y, z) of the current pose, or None."""
        p = self._pose
        if p is None:
            return None
        pos = p.pose.pose.position
        return (pos.x, pos.y, pos.z)

    # ---------- publishers ----------

    def _publish_status(self):
        with self._core_lock:
            m = self._machine.snapshot()
        msg = MissionStatus()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.header.frame_id = ""
        msg.state = m.state
        msg.mission_id = m.mission_id
        msg.request_id = m.request_id
        msg.sequence = m.sequence
        msg.route_id = m.route_id
        msg.map_id = m.map_id
        msg.map_version = m.map_version
        msg.progress = m.progress if m.state != C.MISSION_NONE else 0.0
        msg.reason_code = m.reason_code
        msg.reason_text = m.reason_text
        self._status_pub.publish(msg)

    def _flush_events(self):
        with self._core_lock:
            evs = self._machine.drain_events()
        for rec in evs:
            msg = MissionEvent()
            msg.header.stamp = self.get_clock().now().to_msg()
            msg.header.frame_id = ""
            msg.mission_id = rec.mission_id
            msg.sequence = rec.seq
            msg.event = rec.event
            msg.mission_state = rec.mission_state
            msg.progress = rec.progress
            msg.reason_code = rec.reason_code
            msg.reason_text = rec.reason_text
            self._events_pub.publish(msg)

    # ---------- ControlAuthority ----------

    def _call_authority(self, op, client_id, reason):
        """Synchronous (blocking) authority call with a 2 s timeout.

        Returns the Response, or None when the service is unavailable /
        times out (the caller must treat that as a denial). Never call
        with the core lock held.
        """
        if not self._authority_client.service_is_ready():
            self.get_logger().warning(
                "authority service %s not ready (%s)",
                self._authority_service, reason)
            return None
        req = ControlAuthority.Request()
        req.op = op
        req.owner_type = C.AUTHORITY_MISSION
        req.client_id = client_id
        req.lease_sec = self._lease_sec
        req.reason = reason
        fut = self._authority_client.call_async(req)
        if not fut.wait_for_future(timeout=Duration(seconds=2.0)):
            self.get_logger().warning(
                "authority call timed out (op=%d %s)", op, reason)
            return None
        try:
            return fut.result()
        except Exception as exc:  # service error
            self.get_logger().warning("authority call failed: %s", exc)
            return None

    def _release_authority(self, mission_id):
        self._renew_for = None
        self._renew_failures = 0
        self._call_authority(
            C.OP_RELEASE, "mission-%s" % mission_id, "release")

    # ---------- FollowRoute client (segment legs) ----------

    def _build_segment_goal(self, mission, ctrl, seg) -> FollowRoute.Goal:
        info = self._routes.load(mission.route_id)
        points = self._routes.load_points(mission.route_id)
        sub = points[seg.start_index:seg.end_index + 1]
        goal = FollowRoute.Goal()
        # Distinct per leg: the planner dedups mission ids that reached
        # a terminal result, so each leg (and future retry) needs its own.
        goal.mission_id = ctrl.planner_goal_id(mission.mission_id)
        goal.request_id = mission.request_id
        goal.sequence = int(mission.sequence)
        goal.route_id = mission.route_id
        goal.map_id = mission.map_id
        goal.map_version = mission.map_version
        goal.speed_scale = 0.0  # planner default
        goal.path = _build_path(info.frame_id, sub)
        return goal

    def _send_segment(self, mid, seg):
        """Send the FollowRoute goal for one leg (executor thread)."""
        with self._core_lock:
            m = self._machine.get(mid)
            ctrl = self._seg_ctrl.get(mid)
        if m is None or not m.is_active or ctrl is None:
            return
        if m.state == C.MISSION_PAUSED:
            # Pause between the leg being due and it going out: hold the
            # goal; the resume path re-drives it (the controller is left
            # in the moving phase without a goal in flight).
            return
        if not self._follow_client.server_is_ready():
            self.get_logger().error(
                "navigation planner is not available on %s",
                self._follow_route_action)
            with self._core_lock:
                self._machine.on_planner_lost(
                    mid, "navigation planner is not available")
                ctrl.on_segment_result(False)
            self._flush_events()
            self._publish_status()
            return
        try:
            fut = self._follow_client.send_goal_async(
                self._build_segment_goal(m, ctrl, seg),
                feedback_callback=self._on_follow_feedback)
        except Exception as exc:
            self.get_logger().error("failed to send follow goal: %s", exc)
            with self._core_lock:
                self._machine.on_planner_lost(
                    mid, "failed to send navigation goal: %s" % exc)
                ctrl.on_segment_result(False)
            self._flush_events()
            self._publish_status()
            return
        ctrl.on_goal_sent()
        self._follow_sent.add(mid)
        self._last_feedback_at[mid] = time.monotonic()
        fut.add_done_callback(
            lambda f, mid=mid: self._on_follow_goal_dispatched(f, mid))

    def _start_segments(self, mid):
        """Create the mission's SegmentController and start its first leg
        (dispatch path). Resume re-drives via _resume_segments instead."""
        with self._core_lock:
            plan = self._machine.get_plan(mid)
            if plan is None:
                return
            ctrl = SegmentController(plan)
            self._seg_ctrl[mid] = ctrl
            next_action, seg = ctrl.initial()
        self._proceed(mid, next_action, seg)

    def _resume_segments(self, mid):
        """Re-drive a leg whose goal never went out (paused while the
        previous leg was still due). No-op otherwise."""
        with self._core_lock:
            ctrl = self._seg_ctrl.get(mid)
            if ctrl is None or ctrl.state.phase != PHASE_MOVING:
                return
            need_send = mid not in self._follow_sent
            seg = ctrl.state.current
        if need_send:
            self._send_segment(mid, seg)

    def _proceed(self, mid, next_action, seg):
        """Executor thread: do what the controller asked for."""
        if next_action == NEXT_SEND:
            self._send_segment(mid, seg)
        elif next_action == NEXT_CHECKPOINT:
            self._begin_checkpoint(mid, seg)
        else:  # NEXT_DONE
            self._finish_mission(mid)

    def _finish_mission(self, mid):
        """No legs left: the route is complete."""
        with self._core_lock:
            self._seg_ctrl.pop(mid, None)
            self._machine.on_planner_result(
                mid, True, C.PLANNER_REASON_OK, "route completed", 1.0)
        self._flush_events()
        self._publish_status()

    def _process_segment_advance(self, mid):
        """Periodic: the checkpoint worker flagged its leg finished."""
        with self._core_lock:
            ctrl = self._seg_ctrl.get(mid)
            if ctrl is None or not ctrl.state.advance_request:
                return
            m = self._machine.get(mid)
            if m is None or not m.is_active:
                self._seg_ctrl.pop(mid, None)
                return
            failed_reason = ctrl.state.checkpoint_failed
            if failed_reason is not None:
                # on_failure="fail": the mission ends FAILED here.
                self._machine.on_checkpoint_failed(
                    mid, ctrl.state.current.checkpoint_id, failed_reason)
                self._seg_ctrl.pop(mid, None)
                return
            next_action, seg = ctrl.consume_advance()
        if next_action == NEXT_DONE:
            self._finish_mission(mid)
        else:
            self._proceed(mid, next_action, seg)

    def _on_follow_goal_dispatched(self, fut, mission_id):
        try:
            gh = fut.result()
        except Exception:
            gh = None
        with self._core_lock:
            m = self._machine.get(mission_id)
            ctrl = self._seg_ctrl.get(mission_id)
            if gh is None or not gh.accepted:
                if m is not None and m.is_active:
                    self._machine.on_planner_rejected(
                        mission_id, "planner rejected goal")
                    if ctrl is not None:
                        ctrl.on_segment_result(False)
                self._follow_sent.discard(mission_id)
                self._flush_events()
                self._publish_status()
                return
            if m is not None and m.state == C.MISSION_CANCELED:
                # Canceled between send and accept: cancel immediately.
                self._follow_sent.discard(mission_id)
                self._teardown_follow(mission_id)
                return
            self._follow_handles[mission_id] = gh
        # get_result_async() resolves to the GetResult response; its
        # .result is the action Result (None for canceled/unknown goals).
        # It works even after rclpy drops the handle from its dict on
        # the terminal status — it is a plain service call by goal id.
        gh.get_result_async().add_done_callback(
            lambda f, mid=mission_id: self._on_follow_result(f, mid))

    def _on_follow_feedback(self, feedback_msg):
        fb = feedback_msg.feedback
        mid = fb.mission_id
        self._last_feedback_at[mid] = time.monotonic()
        with self._core_lock:
            ctrl = self._seg_ctrl.get(mid)
            self._last_pose[mid] = _pose_tuple(fb.current_pose)
            # Progress is per-leg (0..1) on the wire; map it to overall
            # route progress so the App sees a monotonic 0..1 bar.
            if ctrl is not None:
                progress = ctrl.progress(fb.progress)
            else:
                progress = fb.progress
            self._machine.on_planner_feedback(
                mid, int(fb.state), progress, fb.status_text)
        self._flush_events()
        self._publish_status()

    def _on_follow_result(self, fut, mission_id):
        """A leg's FollowRoute goal reached a terminal status.

        Success -> run the leg's checkpoint (or finish the mission if it
        was the last leg). Failure -> the mission ends FAILED (no leg
        retry in V1). Lost/canceled -> on_planner_lost (a no-op when our
        own cancel path already terminated the mission).
        """
        try:
            response = fut.result()
        except Exception:
            response = None
        # The result future resolves to the GetResult response;
        # response.result is the action Result, or None for a canceled
        # / unknown goal id (which we treat as a lost planner below).
        result = getattr(response, "result", None) if response \
            else None
        success = None
        reason_code = 0
        reason_text = ""
        final_progress = 0.0
        if result is not None:
            success = bool(result.success)
            reason_code = int(result.reason_code)
            reason_text = result.reason_text
            final_progress = result.final_progress
        with self._core_lock:
            ctrl = self._seg_ctrl.get(mission_id)
            # ctrl can be None when a cancel/teardown raced ahead on the
            # executor thread: the mission is already terminal, so only
            # the controller bookkeeping is skipped.
            if success is True:
                if ctrl is not None:
                    ctrl.on_segment_result(True)  # the periodic check
                    # consumes the advance (checkpoint, or next leg)
            elif success is False:
                self._machine.on_planner_result(
                    mission_id, False, reason_code, reason_text,
                    ctrl.progress(final_progress)
                    if ctrl is not None else final_progress)
                if ctrl is not None:
                    ctrl.on_segment_result(False)
            else:
                # Canceled (or unknown) without a usable result: our
                # cancel path already terminated the mission; if it is
                # somehow still active, the leg is lost.
                self._machine.on_planner_lost(mission_id)
                if ctrl is not None:
                    ctrl.on_segment_result(False)
            self._follow_handles.pop(mission_id, None)
            self._goal_terminal_since.pop(mission_id, None)
            self._follow_sent.discard(mission_id)
        self._flush_events()
        self._publish_status()

    def _teardown_follow(self, mission_id):
        """Cancel the in-flight leg goal (if any) and drop the mission's
        segment state. Idempotent; called from every terminal path."""
        with self._core_lock:
            self._seg_ctrl.pop(mission_id, None)
            self._last_pose.pop(mission_id, None)
        self._follow_sent.discard(mission_id)
        gh = self._follow_handles.pop(mission_id, None)
        self._goal_terminal_since.pop(mission_id, None)
        self._last_fb.pop(mission_id, None)
        if gh is None:
            return
        try:
            gh.cancel_goal_async()
        except Exception:
            pass

    # ---------- checkpoints (Phase 3) ----------

    def _begin_checkpoint(self, mid, seg):
        """Robot arrived at the leg's end; start the worker thread that
        runs the checkpoint's actions."""
        with self._core_lock:
            ctrl = self._seg_ctrl.get(mid)
            if ctrl is None or ctrl.state.phase != PHASE_CHECKPOINT:
                return
            m = self._machine.get(mid)
            if m is None or not m.is_active:
                return
            self._machine.on_checkpoint_started(mid, seg.checkpoint_id)
        self._flush_events()
        self._publish_status()
        self.get_logger().info(
            "mission %s: checkpoint %s started", mid, seg.checkpoint_id)
        t = threading.Thread(
            target=self._checkpoint_worker,
            args=(mid, seg.checkpoint_id),
            name="checkpoint-%s-%s" % (mid, seg.checkpoint_id),
            daemon=True)
        t.start()

    def _mission_inactive(self, mid):
        with self._core_lock:
            m = self._machine.get(mid)
            return m is None or not m.is_active

    def _mission_paused(self, mid):
        with self._core_lock:
            m = self._machine.get(mid)
            return m is not None and m.state == C.MISSION_PAUSED

    def _checkpoint_worker(self, mid, cp_id):
        """Worker thread: run one checkpoint's actions, then flag the
        controller. All machine mutations stay on the executor thread
        (the periodic check reads the controller's flag)."""
        with self._core_lock:
            ctrl = self._seg_ctrl.get(mid)
            spec = (ctrl.state.plan.specs[cp_id]
                    if ctrl is not None else None)
        if spec is None:
            self.get_logger().error(
                "checkpoint worker for %s/%s: no plan (mission ended?)",
                mid, cp_id)
            return
        runner = CheckpointRunner(
            _WorkerExecutors(self, mid),
            is_paused=lambda: self._mission_paused(mid),
            should_abort=lambda: self._mission_inactive(mid),
            on_record=lambda rec: self._on_checkpoint_record(
                mid, cp_id, rec))
        try:
            outcome = runner.run(spec)
        except Exception as exc:
            self.get_logger().error(
                "checkpoint worker %s/%s crashed: %s", mid, cp_id, exc)
            self._checkpoint_done(mid, cp_id, "checkpoint crashed: %s" % exc)
            return
        if outcome.aborted:
            return  # mission canceled/terminated; nothing left to do
        self._checkpoint_done(
            mid, cp_id, outcome.fail_reason if outcome.failed else None)

    def _checkpoint_done(self, mid, cp_id, fail_reason):
        with self._core_lock:
            # Clears the mission's current_checkpoint_id (feedback) before
            # the controller moves on to the next leg.
            self._machine.on_checkpoint_finished(mid)
            ctrl = self._seg_ctrl.get(mid)
            if ctrl is not None:
                try:
                    ctrl.checkpoint_finished(fail_reason)
                except RuntimeError as exc:
                    # The mission left the checkpoint phase in the
                    # meantime (canceled); the flag is moot.
                    self.get_logger().warning(
                        "checkpoint %s/%s done flag ignored: %s",
                        mid, cp_id, exc)
        self.get_logger().info(
            "mission %s: checkpoint %s %s",
            mid, cp_id,
            "FAILED (%s)" % fail_reason if fail_reason else "finished")

    def _on_checkpoint_record(self, mid, cp_id, rec):
        """Worker thread: persist one evidence record + publish it."""
        with self._core_lock:
            m = self._machine.get(mid)
            map_id = m.map_id if m is not None else ""
            map_version = m.map_version if m is not None else ""
            self._store.append_checkpoint_result(
                mid, cp_id, rec.action_type, rec.status, rec.attempts,
                rec.reason, rec.artifact_path, rec.result_json,
                self._last_pose.get(mid), map_id, map_version,
                __version__, _iso_utc_now())
        msg = CheckpointResult()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.header.frame_id = ""
        msg.mission_id = mid
        msg.checkpoint_id = cp_id
        msg.action_type = rec.action_type
        msg.status = rec.status
        msg.attempts = rec.attempts
        msg.reason = rec.reason
        msg.artifact_path = rec.artifact_path
        msg.result_json = rec.result_json
        pose = self._last_pose.get(mid)
        if pose is not None:
            msg.pose.position.x = pose[0]
            msg.pose.position.y = pose[1]
            msg.pose.position.z = pose[2]
            msg.pose.orientation = _yaw_to_quaternion(pose[3])
        msg.map_id = map_id
        msg.map_version = map_version
        msg.software_version = __version__
        self._checkpoint_pub.publish(msg)

    def _call_perception(self, client, service_name, req, timeout,
                         what, mid):
        """Blocking perception call, abortable on mission termination.

        Returns (response, None) or (None, error_text). Runs on the
        worker thread; the core lock is only taken for the quick
        active-mission check inside the wait.
        """
        if not client.service_is_ready():
            return None, "perception service %s not available" % service_name
        try:
            fut = client.call_async(req)
        except Exception as exc:
            return None, "%s call failed: %s" % (what, exc)

        def aborted():
            return self._mission_inactive(mid)

        if not wait_with_cancel(fut.done, aborted, timeout, poll_sec=0.2):
            if aborted():
                return None, "mission terminated while %s" % what
            return None, "%s timed out after %.0f s" % (what, timeout)
        try:
            return fut.result(), None
        except Exception as exc:
            return None, "%s call failed: %s" % (what, exc)

    def _do_photo(self, mid, count):
        req = CapturePhoto.Request()
        req.count = int(count)
        resp, err = self._call_perception(
            self._photo_client, self._capture_photo_service, req,
            self._capture_timeout_sec, "photographing", mid)
        if resp is None:
            return CaptureOutcome(False, err)
        return CaptureOutcome(bool(resp.ok), resp.message,
                              ";".join(resp.artifact_paths), "")

    def _do_record(self, mid, seconds):
        req = StartRecord.Request()
        req.seconds = float(seconds)
        resp, err = self._call_perception(
            self._record_client, self._capture_record_service, req,
            self._record_timeout_sec, "recording", mid)
        if resp is None:
            return CaptureOutcome(False, err)
        return CaptureOutcome(bool(resp.ok), resp.message,
                              resp.artifact_path, "")

    def _do_recognize(self, mid, target):
        req = Recognize.Request()
        req.target = target
        resp, err = self._call_perception(
            self._recognize_client, self._recognize_service, req,
            self._capture_timeout_sec, "recognizing", mid)
        if resp is None:
            return CaptureOutcome(False, err)
        return CaptureOutcome(bool(resp.ok), resp.message, "",
                              resp.result_json)

    # ---------- GetCheckpointResults service ----------

    def _stamp_from_iso(self, s, fallback):
        try:
            dt = datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.%fZ")
            sec = int(dt.timestamp())
            t = Time()
            t.sec = sec
            t.nanosec = int(round((dt.timestamp() - sec) * 1e9))
            return t
        except Exception:
            return fallback

    def _on_get_results(self, request, response):
        with self._core_lock:
            rows = self._store.get_checkpoint_results(request.mission_id)
        now = self.get_clock().now().to_msg()
        for row in rows:
            r = CheckpointResult()
            r.header.stamp = self._stamp_from_iso(row["created_at"], now)
            r.header.frame_id = ""
            r.mission_id = row["mission_id"]
            r.checkpoint_id = row["checkpoint_id"]
            r.action_type = row["action_type"]
            r.status = int(row["status"])
            r.attempts = int(row["attempts"])
            r.reason = row["reason"]
            r.artifact_path = row["artifact_path"]
            r.result_json = row["result_json"]
            r.pose.position.x = row["pose_x"]
            r.pose.position.y = row["pose_y"]
            r.pose.position.z = row["pose_z"]
            r.pose.orientation = _yaw_to_quaternion(row["pose_yaw"])
            r.map_id = row["map_id"]
            r.map_version = row["map_version"]
            r.software_version = row["software_version"]
            response.results.append(r)
        return response

    # ---------- ExecuteInspection server ----------

    def _dispatch_inner(self, dispatch_goal):
        """Shared dispatch pipeline for both entry points (the
        ExecuteInspection action and the DispatchMission service), so
        gates, side effects and reason codes are identical regardless of
        how the mission was requested.

        Runs: machine dispatch -> event flush -> supersede teardown ->
        planner-ready check -> authority acquire -> confirm ->
        segment plan start (first leg goal or first checkpoint).

        Returns (kind, reason_code, reason_text, progress, mission_id,
        mission) where kind is:
          "rejected"    no mission was created
          "duplicate"   replay; mission is the original (terminal or
                        still active); code/text/progress are its
                        terminal_result answer
          "dispatched"  new mission confirmed, first leg in flight (or
                        its first checkpoint running)
          "failed"      mission created but dispatch did not complete
                        (dropped by abort_created, which also frees the
                        (request_id, sequence) key for a retry, or
                        terminated); mission is None once dropped
        """
        with self._core_lock:
            outcome = self._machine.dispatch(
                dispatch_goal, self._robot_view())
        self._flush_events()

        if outcome.action == "reject":
            return ("rejected", outcome.reason_code, outcome.reason_text,
                    0.0, "", None)

        if outcome.action == "duplicate":
            with self._core_lock:
                _, code, text, progress = \
                    self._machine.terminal_result(outcome.mission)
            return ("duplicate", code, text, progress,
                    outcome.mission.mission_id, outcome.mission)

        mission = outcome.mission
        mid = mission.mission_id

        if outcome.superseded is not None:
            sup = outcome.superseded
            self._teardown_follow(sup.mission_id)
            self._release_authority(sup.mission_id)
            self._flush_events()
            self._publish_status()

        if not self._follow_client.server_is_ready():
            text = "navigation planner is not available"
            with self._core_lock:
                self._machine.abort_created(mid, C.REASON_REJECTED, text)
            self._flush_events()
            return ("failed", C.REASON_REJECTED, text, 0.0, mid, None)

        # Blocking (up to 2 s): never with the core lock held.
        resp = self._call_authority(
            C.OP_ACQUIRE, mission.authority_client_id, "dispatch")
        if resp is None or not resp.accepted:
            if resp is None:
                text = "control authority service unavailable"
            else:
                text = ("control authority denied (active owner=%d %s)"
                        % (int(resp.active_owner_type),
                           resp.active_client_id or "?"))
            with self._core_lock:
                self._machine.abort_created(mid, C.REASON_CONTROL_DENIED,
                                            text)
            self._flush_events()
            return ("failed", C.REASON_CONTROL_DENIED, text, 0.0, mid, None)

        with self._core_lock:
            self._machine.confirm_dispatch(mid)
        self._flush_events()
        self._publish_status()
        self._renew_for = mid
        self._renew_failures = 0

        self._start_segments(mid)

        with self._core_lock:
            m = self._machine.get(mid)
            if m is not None and not m.is_active:
                _, code, text, progress = self._machine.terminal_result(m)
                return ("failed", code, text, progress, mid, m)
        return ("dispatched", C.REASON_OK, "", 0.0, mid,
                self._machine.get(mid))

    async def _execute_cb(self, goal_handle):
        goal = goal_handle.goal
        kind, code, text, progress, mid, mission = self._dispatch_inner(
            DispatchGoal(
                mission_id=goal.mission_id,
                request_id=goal.request_id,
                sequence=int(goal.sequence),
                map_id=goal.map_id,
                map_version=goal.map_version,
                route_id=goal.route_id,
                checkpoint_ids=tuple(goal.checkpoint_ids),
            ))

        if kind != "dispatched":
            # Terminal answer without a live goal to wait on: success
            # only for a replay of a mission that already succeeded.
            ok = kind == "duplicate" and mission is not None and \
                mission.state == C.MISSION_SUCCEEDED
            if ok:
                goal_handle.succeed()
            else:
                goal_handle.abort()
            return self._make_result(goal, code, text, progress,
                                     mid or None)

        canceled_by_user = False
        while rclpy.ok():
            m = self._machine.get(mid)
            if m is not None and m.is_terminal:
                break
            # rclpy's ServerGoalHandle.is_cancel_requested is a PROPERTY
            # (verified in ros2/rclpy humble/iron/jazzy): a bare read
            # returns the bool; calling it raises TypeError.
            if goal_handle.is_cancel_requested:
                ok, code, text = self._machine.cancel(mid)
                self._flush_events()
                if ok:
                    self._teardown_follow(mid)
                    self._release_authority(mid)
                    canceled_by_user = True
                break
            self._publish_execute_feedback(goal_handle, mid)
            await asyncio.sleep(0.5)

        m = self._machine.get(mid)
        if m is None or not m.is_terminal:
            # rclpy is shutting down; ensure a terminal state.
            self._machine.shutdown()
            self._flush_events()
            m = self._machine.get(mid)
        ok, code, text, progress = self._machine.terminal_result(m)
        self._teardown_follow(mid)
        self._release_authority(mid)
        if canceled_by_user:
            goal_handle.canceled()
        else:
            if ok:
                goal_handle.succeed()
            else:
                goal_handle.abort()
        return self._make_result(goal, code, text, progress, mid)

    def _publish_execute_feedback(self, goal_handle, mission_id):
        with self._core_lock:
            m = self._machine.get(mission_id)
            if m is None or not m.is_active:
                return
            key = (m.state, m.progress, m.current_checkpoint_id)
            if self._last_fb.get(mission_id) == key:
                return
            self._last_fb[mission_id] = key
            checkpoint_id = m.current_checkpoint_id
            state = m.state
            progress = m.progress
            status_text = m.status_text
        fb = ExecuteInspection.Feedback()
        fb.mission_id = mission_id
        fb.state = state
        fb.progress = progress
        fb.current_checkpoint_id = checkpoint_id
        fb.status_text = status_text
        goal_handle.publish_feedback(fb)

    def _make_result(self, goal, code, text, progress, mission_id=None):
        r = ExecuteInspection.Result()
        r.success = (code == C.REASON_OK)
        r.reason_code = code
        r.reason_text = text
        r.final_progress = progress
        r.mission_id = mission_id if mission_id is not None \
            else (goal.mission_id or "")
        return r

    # ---------- ReturnToDock server (Phase 3 return-to-dock) ----------

    def _rtd_leg_id(self, request_id):
        """Sanitized chain id: planner mission_id, Dock goal
        request_id and the MISSION lease client id
        ("mission-rtd-<san>"). Capped so that the dock node's client
        id "docking-rtd-<san>" stays within the gateway's 64-char
        client-id limit."""
        san = "".join(
            ch for ch in request_id
            if (ch.isascii() and ch.isalnum()) or ch in "-_")[:52]
        return "rtd-%s" % (san or "unknown")

    def _rtd_dock_pose(self, ctx):
        """GetDockConfig for the current map -> the standoff point
        (x, y): the dock pose backed off by approach_distance along
        its approach axis (the dock's yaw faces the dock face; the
        approach comes from behind it). None when the service is
        unavailable or no dock is configured."""
        if not self._dock_config_client.service_is_ready():
            return None
        req = GetDockConfig.Request()
        req.map_id = ctx.map_id
        req.map_version = ctx.map_version
        try:
            fut = self._dock_config_client.call_async(req)
        except Exception:
            return None
        if not fut.wait_for_future(timeout=Duration(seconds=2.0)):
            return None
        try:
            resp = fut.result()
        except Exception:
            return None
        if not resp.found:
            return None
        return (
            resp.pose_x
            - math.cos(resp.pose_yaw) * resp.approach_distance,
            resp.pose_y
            - math.sin(resp.pose_yaw) * resp.approach_distance)

    def _wait_goal_terminal(self, gh, timeout_sec, what):
        """Bounded wait (executor thread) until a goal handle reaches
        a terminal status. The low-battery handoff uses it so the
        planner is idle before the RTD nav goal is sent; the wait is
        rare (one per low-battery interrupt) and bounded."""
        deadline = time.monotonic() + timeout_sec
        while time.monotonic() < deadline:
            try:
                status = gh.status
            except Exception:
                return
            if status in (GoalStatus.STATUS_SUCCEEDED,
                          GoalStatus.STATUS_ABORTED,
                          GoalStatus.STATUS_CANCELED):
                return
            time.sleep(0.1)
        self.get_logger().warning(
            "%s cancel did not settle within %.1f s", what, timeout_sec)

    def _rtd_begin(self, goal):
        """Full return-to-dock acceptance pipeline (executor thread).

        Order: pure gates -> (blocking) dock lookup -> low-battery
        mission interrupt -> (blocking) nav-leg lease acquire -> commit
        (begin chain + mark the request id executed) -> send the nav
        leg. Never holds the core lock across a blocking call.

        Returns (accepted, reason_code, reason_text, rtd).
        """
        request_id = goal.request_id or ""
        trigger = int(goal.trigger)
        with self._core_lock:
            busy = self._rtd_machine.active() is not None
            replayed = bool(request_id) and \
                self._rtd_machine.was_executed(request_id)
        ctx = self._rtd_robot_view()
        ok, code, text, standoff = check_goal(
            request_id, trigger, ctx, busy, replayed,
            lambda: self._rtd_dock_pose(ctx))
        if not ok:
            return (False, code, text, None)

        # A low-battery return interrupts the active mission first
        # (INTERRUPTED, never auto-resumed).
        interrupted = ""
        if trigger == C.RTD_TRIGGER_LOW_BATTERY:
            with self._core_lock:
                m = self._machine.active_mission()
                if m is not None:
                    self._machine.on_authority_lost(
                        "low battery: returning to dock")
            if m is not None:
                interrupted = m.mission_id
                # Grab the in-flight leg handle before teardown pops
                # it: the planner is a single-route FSM, so the RTD
                # nav goal must not arrive while the old leg is still
                # unwinding.
                with self._core_lock:
                    old_gh = self._follow_handles.get(interrupted)
                self._flush_events()
                self._teardown_follow(interrupted)
                self._release_authority(interrupted)
                if old_gh is not None:
                    self._wait_goal_terminal(
                        old_gh, 3.0, "interrupted mission leg")
                self._publish_status()

        # Nav-leg lease (blocking, up to 2 s; never with the core
        # lock held).
        rtd_id = self._rtd_leg_id(request_id)
        resp = self._call_authority(
            C.OP_ACQUIRE, "mission-%s" % rtd_id, "return-to-dock")
        if resp is None or not resp.accepted:
            if resp is None:
                text = "control authority service unavailable"
            else:
                text = ("control authority denied (active owner=%d %s)"
                        % (int(resp.active_owner_type),
                           resp.active_client_id or "?"))
            return (False, C.RTD_REASON_CONTROL_DENIED, text, None)

        # Commit. Re-check the busy flag: a concurrent goal may have
        # won the race while we were in the blocking calls above.
        with self._core_lock:
            if self._rtd_machine.active() is not None:
                rtd = None
            else:
                rtd = self._rtd_machine.begin(
                    request_id, trigger, interrupted)
        if rtd is None:
            self._call_authority(
                C.OP_RELEASE, "mission-%s" % rtd_id, "return race lost")
            return (False, C.RTD_REASON_REJECTED,
                    "return to dock in progress", None)

        self._rtd_leg_id_ = rtd_id
        self._rtd_map_id = ctx.map_id
        self._rtd_map_version = ctx.map_version
        self._rtd_standoff = standoff
        self._renew_for = rtd_id
        self._rtd_renew_failures = 0
        self._rtd_lease_held = True
        self._rtd_nav_sent = False
        self._rtd_dock_sent = False
        self._rtd_follow_handle = None
        self._rtd_dock_handle = None
        self._rtd_terminal_since = None
        self._rtd_last_fb = None
        self._rtd_last_nav_fb_at = time.monotonic()
        self._send_rtd_nav()
        return (True, C.RTD_REASON_OK, "", rtd)

    def _send_rtd_nav(self):
        """Send the nav leg's FollowRoute goal (executor thread).

        The path is exactly two points — current pose -> standoff —
        because the planner rejects paths with fewer than two
        waypoints."""
        rtd = self._rtd_machine.active()
        if rtd is None:
            return
        if not self._follow_client.server_is_ready():
            self._rtd_fail_nav("navigation planner is not available")
            return
        pose = self._rtd_pose()
        if pose is None or self._rtd_standoff is None:
            self._rtd_fail_nav("no current pose for the nav leg")
            return
        goal = FollowRoute.Goal()
        goal.mission_id = self._rtd_leg_id_
        goal.request_id = rtd.request_id
        goal.sequence = 0
        goal.route_id = ""
        goal.map_id = self._rtd_map_id
        goal.map_version = self._rtd_map_version
        goal.speed_scale = 0.0  # planner default
        goal.path = _build_path(
            "lio_map",
            [(pose[0], pose[1], pose[2]),
             (self._rtd_standoff[0], self._rtd_standoff[1], 0.0)])
        try:
            fut = self._follow_client.send_goal_async(
                goal, feedback_callback=self._on_rtd_follow_feedback)
        except Exception as exc:
            self._rtd_fail_nav("failed to send navigation goal: %s" % exc)
            return
        self._rtd_nav_sent = True
        self._rtd_last_nav_fb_at = time.monotonic()
        fut.add_done_callback(
            lambda f: self._on_rtd_follow_goal_dispatched(f))

    def _rtd_fail_nav(self, text):
        with self._core_lock:
            rtd = self._rtd_machine.active()
            if rtd is not None and not rtd.terminal:
                rtd.on_nav_result(False, C.PLANNER_REASON_ABORTED, text)

    def _on_rtd_follow_goal_dispatched(self, fut):
        try:
            gh = fut.result()
        except Exception:
            gh = None
        with self._core_lock:
            rtd = self._rtd_machine.active()
            if rtd is not None and not rtd.terminal and \
                    (gh is None or not gh.accepted):
                rtd.on_nav_result(
                    False, C.PLANNER_REASON_GOAL_REJECTED,
                    "planner rejected the return-to-dock goal")
                return
        self._rtd_follow_handle = gh
        self._rtd_terminal_since = None
        # get_result_async() resolves to the GetResult response (its
        # .result is the action Result), even after rclpy drops the
        # handle from its dict on the terminal status.
        gh.get_result_async().add_done_callback(self._on_rtd_follow_result)

    def _on_rtd_follow_feedback(self, feedback_msg):
        fb = feedback_msg.feedback
        self._rtd_last_nav_fb_at = time.monotonic()
        with self._core_lock:
            rtd = self._rtd_machine.active()
            if rtd is not None and not rtd.terminal:
                rtd.on_nav_feedback(float(fb.progress), fb.status_text)

    def _on_rtd_follow_result(self, fut):
        """The nav leg reached a terminal status: success -> release
        the nav-leg lease and send the dock leg (handoff); failure ->
        the chain ends NAVIGATION_FAILED. Goal-side teardown (cancel,
        bookkeeping) happens in the goal callback's post-loop path."""
        success = None
        reason_code = 0
        reason_text = ""
        try:
            response = fut.result()
        except Exception:
            response = None
        # fut resolves to the GetResult response; .result is the action
        # Result, or None for a canceled / unknown goal id.
        result = getattr(response, "result", None) if response else None
        if result is not None:
            success = bool(result.success)
            reason_code = int(result.reason_code)
            reason_text = result.reason_text
        with self._core_lock:
            rtd = self._rtd_machine.active()
            if rtd is None or rtd.terminal or rtd.state not in (
                    C.RTD_STATE_PREPARING, C.RTD_STATE_NAVIGATING):
                return
            if success is not None:
                rtd.on_nav_result(success, reason_code, reason_text)
            # success is None (canceled/lost): the cancel path already
            # terminated the chain, or the periodic check aborts it.
        if success is True:
            # Handoff: the Dock action acquires its own DOCKING lease;
            # the gateway arbiter maps owners 1:1, so the nav leg's
            # MISSION lease must go first.
            self._release_authority(self._rtd_leg_id_)
            self._send_rtd_dock()

    def _send_rtd_dock(self):
        """Send the dock leg's Dock goal (executor thread)."""
        if not self._dock_client.server_is_ready():
            with self._core_lock:
                rtd = self._rtd_machine.active()
                if rtd is not None and not rtd.terminal:
                    rtd.on_dock_result(
                        False, C.DOCK_REASON_REJECTED,
                        "docking service is not available", False)
            return
        try:
            goal = Dock.Goal()
            # The dock node derives its DOCKING lease client id from
            # this: "docking-rtd-<san>".
            goal.request_id = self._rtd_leg_id_
            fut = self._dock_client.send_goal_async(
                goal, feedback_callback=self._on_rtd_dock_feedback)
        except Exception as exc:
            with self._core_lock:
                rtd = self._rtd_machine.active()
                if rtd is not None and not rtd.terminal:
                    rtd.on_dock_result(
                        False, C.DOCK_REASON_REJECTED,
                        "failed to send docking goal: %s" % exc, False)
            return
        self._rtd_dock_sent = True
        self._rtd_lease_held = False
        fut.add_done_callback(lambda f: self._on_rtd_dock_dispatched(f))

    def _on_rtd_dock_dispatched(self, fut):
        """The dock leg's goal was accepted (or rejected) by the server.
        Only now do we arm the result future."""
        try:
            gh = fut.result()
        except Exception:
            gh = None
        with self._core_lock:
            rtd = self._rtd_machine.active()
            if rtd is not None and not rtd.terminal and \
                    (gh is None or not gh.accepted):
                rtd.on_dock_result(
                    False, C.DOCK_REASON_REJECTED,
                    "docking service rejected the goal", False)
                return
        self._rtd_dock_handle = gh
        gh.get_result_async().add_done_callback(self._on_rtd_dock_result)

    def _on_rtd_dock_feedback(self, feedback_msg):
        fb = feedback_msg.feedback
        with self._core_lock:
            rtd = self._rtd_machine.active()
            if rtd is not None and not rtd.terminal:
                rtd.on_dock_feedback(int(fb.state), float(fb.progress),
                                     fb.status_text)

    def _on_rtd_dock_result(self, fut):
        """The dock leg reached a terminal status: the chain ends (a
        user cancel would have terminated it first)."""
        try:
            response = fut.result()
        except Exception:
            response = None
        result = getattr(response, "result", None) if response \
            else None
        if result is None:
            # Canceled without a usable result: the cancel path already
            # terminated the chain (no-op here).
            return
        with self._core_lock:
            rtd = self._rtd_machine.active()
            if rtd is not None and not rtd.terminal:
                rtd.on_dock_result(
                    bool(result.success),
                    int(result.reason_code),
                    result.reason_text,
                    bool(result.charging))

    def _rtd_abort(self, why):
        with self._core_lock:
            rtd = self._rtd_machine.active()
            if rtd is not None and not rtd.terminal:
                rtd.on_lease_lost(why)
        self.get_logger().warning("return to dock aborted: %s", why)

    def _rtd_tear_down(self):
        """Drop the active chain's bookkeeping and cancel in-flight
        leg goals (only goals that are still running are canceled).
        Idempotent."""
        for handle in (self._rtd_follow_handle, self._rtd_dock_handle):
            if handle is None:
                continue
            try:
                if handle.status in (GoalStatus.STATUS_ACCEPTED,
                                     GoalStatus.STATUS_EXECUTING):
                    handle.cancel_goal_async()
            except Exception:
                pass
        self._rtd_follow_handle = None
        self._rtd_dock_handle = None
        self._rtd_nav_sent = False
        self._rtd_dock_sent = False
        self._rtd_terminal_since = None
        self._rtd_last_fb = None

    def _rtd_cancel_side_effects(self):
        """Terminal side effects: cancel in-flight legs, release the
        nav-leg lease if still held, drop bookkeeping."""
        self._rtd_tear_down()
        if self._rtd_lease_held:
            self._release_authority(self._rtd_leg_id_)
            self._rtd_lease_held = False

    async def _return_cb(self, goal_handle):
        goal = goal_handle.goal
        accepted, code, text, _rtd = self._rtd_begin(goal)
        if not accepted:
            goal_handle.abort()
            return self._make_rtd_result(goal, code, text)

        canceled_by_user = False
        while rclpy.ok():
            rtd = self._rtd_machine.active()
            if rtd is None or rtd.terminal:
                break
            # rclpy's ServerGoalHandle.is_cancel_requested is a PROPERTY
            # (verified in ros2/rclpy humble/iron/jazzy): a bare read
            # returns the bool; calling it raises TypeError.
            if goal_handle.is_cancel_requested:
                with self._core_lock:
                    ok, _c, _t = rtd.cancel("canceled by user")
                canceled_by_user = ok
                break
            self._publish_rtd_feedback(goal_handle)
            await asyncio.sleep(0.5)

        rtd = self._rtd_machine.active()
        if rtd is not None and not rtd.terminal:
            # rclpy is shutting down; ensure a terminal state.
            with self._core_lock:
                rtd.on_lease_lost("mission manager shutting down")
        if rtd is None:
            # Defensive: the chain was cleared concurrently (shutdown).
            code, text, docked, charging = (
                C.RTD_REASON_ABORTED, "return to dock lost", False, False)
        else:
            code = rtd.reason_code
            text = rtd.reason_text
            docked = rtd.docked
            charging = rtd.charging
            self._rtd_machine.clear(rtd.request_id)
        self._rtd_cancel_side_effects()
        if canceled_by_user:
            goal_handle.canceled()
        else:
            if code == C.RTD_REASON_OK:
                goal_handle.succeed()
            else:
                goal_handle.abort()
        return self._make_rtd_result(goal, code, text, docked, charging)

    def _publish_rtd_feedback(self, goal_handle):
        with self._core_lock:
            rtd = self._rtd_machine.active()
            if rtd is None or rtd.terminal:
                return
            key = (rtd.state, round(rtd.progress, 3), rtd.detail)
            if self._rtd_last_fb == key:
                return
            self._rtd_last_fb = key
            request_id = rtd.request_id
            state = rtd.state
            progress = rtd.progress
            detail = rtd.detail
        fb = ReturnToDock.Feedback()
        fb.request_id = request_id
        fb.state = state
        fb.progress = progress
        fb.detail = detail
        goal_handle.publish_feedback(fb)

    def _make_rtd_result(self, goal, code, text, docked=False,
                         charging=False):
        r = ReturnToDock.Result()
        r.success = (code == C.RTD_REASON_OK)
        r.reason_code = code
        r.reason_text = text
        r.docked = docked
        r.charging = charging
        r.final_battery_percentage = self._rtd_battery_pct()
        return r

    def _rtd_battery_pct(self):
        msg = self._robot_state
        if msg is None:
            return float("nan")
        return float(msg.battery_percentage)

    # ---------- low-battery watchdog + RTD liveness (periodic) ----------

    def _check_low_battery(self):
        """Low-battery watchdog: fire a low-battery return exactly once
        per episode (re-arm only while charging, or once the battery
        is back above threshold + hysteresis). Triggers the same chain
        as a user goal, through the node's own action client."""
        if self._battery_low_return_pct <= 0.0:
            return
        with self._core_lock:
            rtd_active = self._rtd_machine.active() is not None
        if rtd_active:
            return
        msg = self._robot_state
        if msg is None or self._last_robot_state_at is None:
            return
        age_ms = (time.monotonic() - self._last_robot_state_at) * 1000.0
        if age_ms > self._robot_state_stale_ms:
            return
        pct = float(msg.battery_percentage)
        if pct != pct:  # NaN: battery unknown
            return
        if not self._lowbatt.evaluate(pct, bool(msg.charging)):
            return
        if not self._rtd_client.server_is_ready():
            return
        self._rtd_seq += 1
        request_id = "lowbatt-%d" % self._rtd_seq
        try:
            goal = ReturnToDock.Goal()
            goal.request_id = request_id
            goal.trigger = C.RTD_TRIGGER_LOW_BATTERY
            goal.mission_id = ""
            self._rtd_client.send_goal_async(goal)
        except Exception as exc:
            self.get_logger().error(
                "low-battery return send failed: %s", exc)
            return
        # Mark fired on the attempt (accepted OR rejected): a rejected
        # return (estop, no dock) must not re-fire every second.
        self._lowbatt.mark_fired()
        self.get_logger().warning(
            "low battery (%.1f%% <= %.1f%%): return to dock %s",
            pct, self._battery_low_return_pct, request_id)

    def _rtd_periodic(self):
        """Nav-leg lease renewal + liveness for the active RTD chain
        (same cadence and rules as mission lease renewal)."""
        with self._core_lock:
            rtd = self._rtd_machine.active()
            state = (rtd.state if rtd is not None and not rtd.terminal
                     else None)
        if state not in (C.RTD_STATE_PREPARING, C.RTD_STATE_NAVIGATING):
            return
        now = time.monotonic()
        if self._rtd_nav_sent:
            if self._renew_for != self._rtd_leg_id_:
                self._renew_for = self._rtd_leg_id_
                self._rtd_renew_failures = 0
            resp = self._call_authority(
                C.OP_RENEW, "mission-%s" % self._rtd_leg_id_,
                "return-to-dock")
            if resp is None:
                self._rtd_renew_failures += 1
                if self._rtd_renew_failures >= 3:
                    self._rtd_abort(
                        "nav-leg lease renewal failed (authority "
                        "service unavailable)")
                return
            self._rtd_renew_failures = 0
            if not resp.accepted or \
                    int(resp.active_owner_type) != C.AUTHORITY_MISSION:
                self._rtd_abort(
                    "nav-leg lease lost (active owner=%d %s)"
                    % (int(resp.active_owner_type),
                       resp.active_client_id or "?"))
                return
        gh = self._rtd_follow_handle
        if self._rtd_nav_sent and gh is not None:
            if gh.status in (GoalStatus.STATUS_SUCCEEDED,
                             GoalStatus.STATUS_ABORTED,
                             GoalStatus.STATUS_CANCELED):
                # The result future normally ends the chain first; give
                # it a grace period, then treat the leg as lost.
                since = self._rtd_terminal_since
                if since is None:
                    self._rtd_terminal_since = now
                elif now - since > 5.0:
                    self._rtd_abort("navigation leg lost (no result)")
                    return
            else:
                self._rtd_terminal_since = None
                last = self._rtd_last_nav_fb_at
                if now - last > self._planner_stale_sec:
                    self._rtd_abort(
                        "planner stopped reporting (no feedback for "
                        "%.0f s)" % self._planner_stale_sec)

    # ---------- DispatchMission service (App entry point) ----------

    def _on_dispatch(self, request, response):
        """App-facing dispatch over the foxglove/rosbridge WS bridges,
        which do not carry ROS 2 actions. Shares _dispatch_inner with
        the action, so idempotency keys, precondition gates and reason
        codes are identical. Fire-and-forget: accepted means the
        mission is PENDING and the first leg has been (or is being)
        started; the outcome is tracked on /omni/mission/status and
        /omni/mission/events, not returned by this call."""
        kind, code, text, _progress, mid, mission = self._dispatch_inner(
            DispatchGoal(
                mission_id=request.mission_id,
                request_id=request.request_id,
                sequence=int(request.sequence),
                map_id=request.map_id,
                map_version=request.map_version,
                route_id=request.route_id,
                checkpoint_ids=tuple(request.checkpoint_ids),
            ))

        if kind == "dispatched":
            response.accepted = True
        elif kind == "duplicate":
            # A replay mirrors the original dispatch outcome: a terminal
            # original is reported as its outcome, an active one as
            # accepted (REASON_DUPLICATE signals the no-op re-dispatch).
            response.accepted = mission is not None and \
                (mission.state == C.MISSION_SUCCEEDED or
                 not mission.is_terminal)
        else:
            response.accepted = False
        response.reason_code = code
        response.reason_text = text
        response.mission_id = mid or request.mission_id
        self._publish_status()
        return response

    # ---------- MissionControl service ----------

    def _active_mid(self):
        with self._core_lock:
            m = self._machine.active_mission()
        return m.mission_id if m is not None else ""

    def _on_mission_control(self, request, response):
        cmd = int(request.command)
        mid = request.mission_id
        if cmd == C.CMD_CANCEL:
            target = mid or self._active_mid()
            if not target:
                response.accepted = False
                response.reason_code = C.REASON_REJECTED
                response.reason_text = "no active mission"
                self._publish_status()
                return response
            with self._core_lock:
                ok, code, text = self._machine.cancel(target)
            self._flush_events()
            if ok:
                # Cancel was accepted; tear down the leg goal (the
                # checkpoint worker notices the terminal state on its
                # next abort check) and the lease.
                self._teardown_follow(target)
                self._release_authority(target)
            response.accepted = ok
            response.reason_code = code
            response.reason_text = text
        elif cmd == C.CMD_PAUSE:
            target = mid or self._active_mid()
            with self._core_lock:
                ok, code, text = self._machine.pause(target)
            self._flush_events()
            if ok:
                # Pause = release the lease; the gateway arbiter then
                # outputs zero velocity and the robot stops cleanly. A
                # running checkpoint worker idles until resume.
                self._release_authority(target)
            response.accepted = ok
            response.reason_code = code
            response.reason_text = text
        elif cmd == C.CMD_RESUME:
            target = mid or self._active_mid()
            with self._core_lock:
                ok, code, text = self._machine.begin_resume(target)
            if ok:
                with self._core_lock:
                    m = self._machine.get(target)
                # Blocking (up to 2 s): never with the core lock held.
                resp = self._call_authority(
                    C.OP_ACQUIRE, m.authority_client_id, "resume")
                if resp is not None and resp.accepted:
                    with self._core_lock:
                        self._machine.finish_resume(m.mission_id)
                    self._flush_events()
                    self._renew_for = m.mission_id
                    self._renew_failures = 0
                    # A leg whose goal never went out (pause landed
                    # between "due" and "sent") is re-driven now.
                    self._resume_segments(m.mission_id)
                    ok, code, text = True, C.REASON_OK, ""
                else:
                    owner = int(resp.active_owner_type) \
                        if resp is not None else -1
                    ok, code, text = (
                        False, C.REASON_CONTROL_DENIED,
                        "cannot re-acquire control authority "
                        "(active owner=%d)" % owner)
            response.accepted = ok
            response.reason_code = code
            response.reason_text = text
        else:
            response.accepted = False
            response.reason_code = C.REASON_REJECTED
            response.reason_text = "unknown command %d" % cmd
        self._publish_status()
        return response

    # ---------- ListRoutes service ----------

    def _on_list_routes(self, request, response):
        infos = self._routes.list_routes()
        response.route_ids = [i.route_id for i in infos]
        response.map_ids = [i.map_id for i in infos]
        response.frame_ids = [i.frame_id for i in infos]
        response.created_at = [i.created_at for i in infos]
        return response

    # ---------- periodic checks ----------

    def _periodic_check(self):
        # Return-to-dock checks run regardless of mission state: the
        # low-battery watchdog and the RTD nav-leg liveness do not
        # depend on an active mission.
        self._check_low_battery()
        self._rtd_periodic()

        with self._core_lock:
            m = self._machine.active_mission()
        if m is None:
            return
        mid = m.mission_id

        # 1) lease renewal (paused missions hold no lease)
        with self._core_lock:
            renewing = m.state in (C.MISSION_PENDING, C.MISSION_EXECUTING)
        if renewing:
            self._renew_lease(m)

        # 2) segment advance (the checkpoint worker finished its leg)
        self._process_segment_advance(mid)

        # 3) planner liveness (only with a leg goal in flight)
        gh = self._follow_handles.get(mid)
        if gh is None:
            return
        now = time.monotonic()
        if gh.status in (GoalStatus.STATUS_SUCCEEDED,
                         GoalStatus.STATUS_ABORTED,
                         GoalStatus.STATUS_CANCELED):
            # The result future normally terminates the mission first;
            # give it a grace period, then treat the leg as lost.
            since = self._goal_terminal_since.setdefault(mid, now)
            if now - since > 5.0:
                with self._core_lock:
                    still_active = (self._machine.get(mid) is not None
                                    and self._machine.get(mid).is_active)
                if still_active:
                    self._machine.on_planner_lost(mid)
                    with self._core_lock:
                        ctrl = self._seg_ctrl.get(mid)
                        if ctrl is not None:
                            ctrl.on_segment_result(False)
                    self._seg_ctrl.pop(mid, None)
                    self._flush_events()
                    self._publish_status()
        elif m.state == C.MISSION_EXECUTING:
            last = self._last_feedback_at.get(mid, now)
            if now - last > self._planner_stale_sec:
                with self._core_lock:
                    ctrl = self._seg_ctrl.get(mid)
                    self._machine.on_planner_lost(
                        mid, "planner stopped reporting (no feedback for "
                             "%.0f s)" % self._planner_stale_sec)
                    if ctrl is not None:
                        ctrl.on_segment_result(False)
                    self._seg_ctrl.pop(mid, None)
                self._flush_events()
                self._publish_status()

    def _renew_lease(self, m):
        if self._renew_for != m.mission_id:
            self._renew_for = m.mission_id
            self._renew_failures = 0
        resp = self._call_authority(
            C.OP_RENEW, m.authority_client_id, "renew")
        if resp is None:
            self._renew_failures += 1
            if self._renew_failures >= 3:
                self._interrupt(
                    m, "mission lease renewal failed (authority "
                       "service unavailable)")
            return
        self._renew_failures = 0
        if not resp.accepted or \
                int(resp.active_owner_type) != C.AUTHORITY_MISSION:
            self._interrupt(
                m, "mission lease lost (active owner=%d %s)"
                % (int(resp.active_owner_type),
                   resp.active_client_id or "?"))

    def _interrupt(self, m, why):
        with self._core_lock:
            lost = self._machine.on_authority_lost(why)
        self._flush_events()
        if lost is not None:
            self.get_logger().warning(
                "mission %s interrupted: %s", lost.mission_id, why)
            self._teardown_follow(lost.mission_id)
            self._publish_status()

    # ---------- lifecycle ----------

    def shutdown(self):
        """Graceful stop (SIGTERM / SIGINT): interrupt active missions,
        abort an active return-to-dock chain, release leases, cancel
        in-flight goals, drop segment state. Checkpoint workers are
        daemon threads; they notice the terminal state and exit on
        their next abort check."""
        try:
            lost = self._machine.shutdown()
            self._flush_events()
            for m in lost:
                self._teardown_follow(m.mission_id)
                self._release_authority(m.mission_id)
                self.get_logger().warning(
                    "interrupted mission %s on shutdown", m.mission_id)
            rtd = self._rtd_machine.shutdown()
            if rtd is not None:
                self._rtd_cancel_side_effects()
                self.get_logger().warning(
                    "aborted return to dock %s on shutdown",
                    rtd.request_id)
            self._publish_status()
        except Exception as exc:
            self.get_logger().error("shutdown cleanup failed: %s", exc)
        finally:
            try:
                self._store.close()
            except Exception:
                pass


class _WorkerExecutors:
    """Duck-typed executor object for CheckpointRunner (Phase 3).

    Binds the node's perception service clients to the worker's mission
    so the runner stays pure.
    """

    def __init__(self, node, mid):
        self._node = node
        self._mid = mid

    def photo(self, count):
        return self._node._do_photo(self._mid, count)

    def record(self, seconds):
        return self._node._do_record(self._mid, seconds)

    def recognize(self, target):
        return self._node._do_recognize(self._mid, target)


def _handle_sigterm(signum, frame):
    # Unwind rclpy.spin() so the finally-block runs node.shutdown().
    raise KeyboardInterrupt


def main(args=None):
    rclpy.init(args=args)
    signal.signal(signal.SIGTERM, _handle_sigterm)
    node = MissionManagerNode()
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