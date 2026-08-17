"""Mission Manager node (V1) — rclpy wiring over the pure core.

Wires MissionMachine (state_machine.py, pure Python) to ROS 2:

  - ExecuteInspection action server on /omni/mission/execute
  - DispatchMission service on /omni/mission/dispatch (App entry point;
    the foxglove/rosbridge WS bridges do not carry ROS 2 actions, so the
    App dispatches through this service; same state machine, gates and
    reason codes as the action)
  - MissionControl service on /omni/mission/control
  - ListRoutes service on /omni/routes/list
  - FollowRoute action client on /omni/navigation/follow_route
  - ControlAuthority client on /omni/control/authority (mission lease)
  - RobotState subscription on /omni/robot_state (dispatch gates)
  - MissionStatus publisher on /omni/mission/status (transient_local)
  - MissionEvent publisher on /omni/mission/events (reliable)
  - SQLite event store + restart recovery (active -> INTERRUPTED,
    never auto-resumed)

Pause semantics: pausing releases the mission lease; the gateway
arbiter then outputs zero velocity (the robot stops cleanly) and
resuming re-acquires the lease. There is no action-protocol pause
primitive.
"""

import asyncio
import math
import signal
import time
from datetime import datetime, timezone

import rclpy
from rclpy.action import ActionClient, ActionServer, GoalStatus
from rclpy.duration import Duration
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy

from geometry_msgs.msg import PoseStamped, Quaternion
from nav_msgs.msg import Path

from omni_robot_interfaces.action import ExecuteInspection, FollowRoute
from omni_robot_interfaces.msg import MissionEvent, MissionStatus, RobotState
from omni_robot_interfaces.srv import (
    ControlAuthority,
    DispatchMission,
    ListRoutes,
    MissionControl,
)

from . import constants as C
from .event_store import EventStore
from .route_store import RouteStore
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


class MissionManagerNode(Node):
    def __init__(self):
        super().__init__("omni_mission_manager")

        # --- parameters (defaults are the production layout) ---
        self._routes_dir = self._param_str("routes_dir",
                                           "/var/lib/omni/routes")
        self._db_path = self._param_str("database",
                                        "/var/lib/omni/mission_manager/missions.db")
        self._robot_state_topic = self._param_str(
            "robot_state_topic", "/omni/robot_state")
        self._status_topic = self._param_str(
            "status_topic", "/omni/mission/status")
        self._events_topic = self._param_str(
            "events_topic", "/omni/mission/events")
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
        self._authority_service = self._param_str(
            "authority_service", "/omni/control/authority")
        self._lease_sec = float(
            self.declare_parameter("lease_sec", 5.0).value)
        self._renew_period_sec = float(
            self.declare_parameter("lease_renew_period_sec", 1.0).value)
        self._robot_state_stale_ms = float(
            self.declare_parameter("robot_state_stale_ms", 2000.0).value)
        self._planner_stale_sec = float(
            self.declare_parameter("planner_stale_sec", 30.0).value)

        # --- pure core ---
        self._store = EventStore(self._db_path)
        self._routes = RouteStore(self._routes_dir)
        self._machine = MissionMachine(
            self._store, self._routes, now_fn=_iso_utc_now)

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

        self._status_pub = self.create_publisher(
            MissionStatus, self._status_topic, reliable_tl)
        self._events_pub = self.create_publisher(
            MissionEvent, self._events_topic, reliable)

        self.create_service(
            MissionControl, self._control_service, self._on_mission_control)
        self.create_service(
            ListRoutes, self._routes_service, self._on_list_routes)
        self.create_service(
            DispatchMission, self._dispatch_service, self._on_dispatch)
        self._authority_client = self.create_client(
            ControlAuthority, self._authority_service)

        self._execute_server = ActionServer(
            self, ExecuteInspection, self._execute_action,
            execute_callback=self._execute_cb)
        self._follow_client = ActionClient(
            self, FollowRoute, self._follow_route_action)

        # per-mission follow goal bookkeeping
        self._follow_handles = {}   # mission_id -> async GoalHandle
        self._follow_sent = set()   # mission_ids with a goal in flight
        self._last_feedback_at = {}  # mission_id -> monotonic seconds
        self._goal_terminal_since = {}  # mission_id -> monotonic seconds
        self._last_fb = {}          # mission_id -> (state, progress)

        # lease bookkeeping
        self._renew_for = None      # mission_id currently holding a lease
        self._renew_failures = 0

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

    # ---------- publishers ----------

    def _publish_status(self):
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
        for rec in self._machine.drain_events():
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
        times out (the caller must treat that as a denial).
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

    # ---------- FollowRoute client ----------

    def _build_follow_goal(self, mission) -> FollowRoute.Goal:
        goal = FollowRoute.Goal()
        goal.mission_id = mission.mission_id
        goal.request_id = mission.request_id
        goal.sequence = int(mission.sequence)
        goal.route_id = mission.route_id
        goal.map_id = mission.map_id
        goal.map_version = mission.map_version
        goal.speed_scale = 0.0  # planner default in V1
        info = self._routes.load(mission.route_id)
        points = self._routes.load_points(mission.route_id)
        path = Path()
        path.header.frame_id = info.frame_id or "lio_map"
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
        goal.path = path
        return goal

    def _send_follow_goal(self, mission_id):
        m = self._machine.get(mission_id)
        if m is None or m.state != C.MISSION_PENDING:
            return
        if not self._follow_client.server_is_ready():
            self.get_logger().error(
                "navigation planner is not available on %s",
                self._follow_route_action)
            self._machine.on_planner_lost(
                mission_id, "navigation planner is not available")
            self._flush_events()
            self._publish_status()
            return
        try:
            fut = self._follow_client.send_goal_async(
                self._build_follow_goal(m),
                feedback_callback=self._on_follow_feedback)
        except Exception as exc:
            self.get_logger().error("failed to send follow goal: %s", exc)
            self._machine.on_planner_lost(
                mission_id, "failed to send navigation goal: %s" % exc)
            self._flush_events()
            self._publish_status()
            return
        self._follow_sent.add(mission_id)
        self._last_feedback_at[mission_id] = time.monotonic()
        fut.add_done_callback(
            lambda f, mid=mission_id: self._on_follow_goal_dispatched(f, mid))

    def _on_follow_goal_dispatched(self, fut, mission_id):
        try:
            gh = fut.result()
        except Exception:
            gh = None
        m = self._machine.get(mission_id)
        if gh is None or not gh.accepted:
            if m is not None and m.is_active:
                self._machine.on_planner_rejected(
                    mission_id, "planner rejected goal")
                self._flush_events()
                self._publish_status()
            return
        if m is not None and m.state == C.MISSION_CANCELED:
            # Canceled between send and accept: cancel immediately.
            self._teardown_follow(mission_id)
            return
        self._follow_handles[mission_id] = gh
        gh.result_async().add_done_callback(
            lambda f, mid=mission_id: self._on_follow_result(f, mid))

    def _on_follow_feedback(self, feedback_msg):
        fb = feedback_msg.feedback
        mid = fb.mission_id
        self._last_feedback_at[mid] = time.monotonic()
        self._machine.on_planner_feedback(
            mid, int(fb.state), fb.progress, fb.status_text)
        self._flush_events()
        self._publish_status()

    def _on_follow_result(self, fut, mission_id):
        try:
            gh = fut.result()
        except Exception:
            gh = None
        if gh is not None and \
                gh.status in (GoalStatus.STATUS_SUCCEEDED,
                              GoalStatus.STATUS_ABORTED):
            try:
                result = fut.result(timeout=5.0)
            except Exception:
                result = None
            if result is not None:
                self._machine.on_planner_result(
                    mission_id, bool(result.success),
                    int(result.reason_code), result.reason_text,
                    result.final_progress)
            else:
                self._machine.on_planner_lost(mission_id)
        else:
            # Canceled (or unknown) without a usable result: our cancel
            # path already terminated the mission; if it is somehow still
            # active, treat the goal as lost.
            self._machine.on_planner_lost(mission_id)
        self._follow_handles.pop(mission_id, None)
        self._goal_terminal_since.pop(mission_id, None)
        self._flush_events()
        self._publish_status()

    def _teardown_follow(self, mission_id):
        gh = self._follow_handles.pop(mission_id, None)
        self._goal_terminal_since.pop(mission_id, None)
        if gh is None:
            return
        try:
            gh.cancel_goal_async()
        except Exception:
            pass

    # ---------- ExecuteInspection server ----------

    def _dispatch_inner(self, dispatch_goal):
        """Shared dispatch pipeline for both entry points (the
        ExecuteInspection action and the DispatchMission service), so
        gates, side effects and reason codes are identical regardless of
        how the mission was requested.

        Runs: machine dispatch -> event flush -> supersede teardown ->
        planner-ready check -> authority acquire -> confirm ->
        FollowRoute goal send.

        Returns (kind, reason_code, reason_text, progress, mission_id,
        mission) where kind is:
          "rejected"    no mission was created
          "duplicate"   replay; mission is the original (terminal or
                        still active); code/text/progress are its
                        terminal_result answer
          "dispatched"  new mission confirmed, follow goal in flight
          "failed"      mission created but dispatch did not complete
                        (dropped by abort_created, which also frees the
                        (request_id, sequence) key for a retry, or
                        terminated); mission is None once dropped
        """
        outcome = self._machine.dispatch(dispatch_goal, self._robot_view())
        self._flush_events()

        if outcome.action == "reject":
            return ("rejected", outcome.reason_code, outcome.reason_text,
                    0.0, "", None)

        if outcome.action == "duplicate":
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
            self._machine.abort_created(mid, C.REASON_REJECTED, text)
            self._flush_events()
            return ("failed", C.REASON_REJECTED, text, 0.0, mid, None)

        resp = self._call_authority(
            C.OP_ACQUIRE, mission.authority_client_id, "dispatch")
        if resp is None or not resp.accepted:
            if resp is None:
                text = "control authority service unavailable"
            else:
                text = ("control authority denied (active owner=%d %s)"
                        % (int(resp.active_owner_type),
                           resp.active_client_id or "?"))
            self._machine.abort_created(mid, C.REASON_CONTROL_DENIED, text)
            self._flush_events()
            return ("failed", C.REASON_CONTROL_DENIED, text, 0.0, mid, None)

        self._machine.confirm_dispatch(mid)
        self._flush_events()
        self._publish_status()
        self._renew_for = mid
        self._renew_failures = 0

        self._send_follow_goal(mid)
        if mid not in self._follow_sent:
            m = self._machine.get(mid)
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
        m = self._machine.get(mission_id)
        if m is None or not m.is_active:
            return
        key = (m.state, m.progress)
        if self._last_fb.get(mission_id) == key:
            return
        self._last_fb[mission_id] = key
        fb = ExecuteInspection.Feedback()
        fb.mission_id = mission_id
        fb.state = m.state
        fb.progress = m.progress
        fb.current_checkpoint_id = ""
        fb.status_text = m.status_text
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

    # ---------- DispatchMission service (App entry point) ----------

    def _on_dispatch(self, request, response):
        """App-facing dispatch over the foxglove/rosbridge WS bridges,
        which do not carry ROS 2 actions. Shares _dispatch_inner with
        the action, so idempotency keys, precondition gates and reason
        codes are identical. Fire-and-forget: accepted means the
        mission is PENDING and the FollowRoute goal has been (or is
        being) sent; the outcome is tracked on /omni/mission/status and
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
            ok, code, text = self._machine.cancel(target)
            self._flush_events()
            if ok:
                # Cancel was accepted; tear down the goal and the lease.
                self._teardown_follow(target)
                self._release_authority(target)
            response.accepted = ok
            response.reason_code = code
            response.reason_text = text
        elif cmd == C.CMD_PAUSE:
            target = mid or self._active_mid()
            ok, code, text = self._machine.pause(target)
            self._flush_events()
            if ok:
                # Pause = release the lease; the gateway arbiter then
                # outputs zero velocity and the robot stops cleanly.
                self._release_authority(target)
            response.accepted = ok
            response.reason_code = code
            response.reason_text = text
        elif cmd == C.CMD_RESUME:
            target = mid or self._active_mid()
            ok, code, text = self._machine.begin_resume(target)
            if ok:
                m = self._machine.get(target)
                resp = self._call_authority(
                    C.OP_ACQUIRE, m.authority_client_id, "resume")
                if resp is not None and resp.accepted:
                    self._machine.finish_resume(m.mission_id)
                    self._flush_events()
                    self._renew_for = m.mission_id
                    self._renew_failures = 0
                    if m.mission_id not in self._follow_sent:
                        # Paused while still PENDING: the goal never went
                        # out. Send it now that the lease is back.
                        self._send_follow_goal(m.mission_id)
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
        m = self._machine.active_mission()
        if m is None:
            return
        mid = m.mission_id

        # 1) lease renewal (paused missions hold no lease)
        if m.state in (C.MISSION_PENDING, C.MISSION_EXECUTING):
            self._renew_lease(m)

        # 2) planner liveness
        gh = self._follow_handles.get(mid)
        if gh is None:
            return
        now = time.monotonic()
        if gh.status in (GoalStatus.STATUS_SUCCEEDED,
                         GoalStatus.STATUS_ABORTED,
                         GoalStatus.STATUS_CANCELED):
            # The result future normally terminates the mission first;
            # give it a grace period, then treat the goal as lost.
            since = self._goal_terminal_since.setdefault(mid, now)
            if now - since > 5.0 and m.is_active:
                self._machine.on_planner_lost(mid)
                self._flush_events()
                self._publish_status()
        elif m.state == C.MISSION_EXECUTING:
            last = self._last_feedback_at.get(mid, now)
            if now - last > self._planner_stale_sec:
                self._machine.on_planner_lost(
                    mid, "planner stopped reporting (no feedback for "
                         "%.0f s)" % self._planner_stale_sec)
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
        release leases, cancel in-flight goals."""
        try:
            lost = self._machine.shutdown()
            self._flush_events()
            for m in lost:
                self._teardown_follow(m.mission_id)
                self._release_authority(m.mission_id)
                self.get_logger().warning(
                    "interrupted mission %s on shutdown", m.mission_id)
            self._publish_status()
        except Exception as exc:
            self.get_logger().error("shutdown cleanup failed: %s", exc)
        finally:
            try:
                self._store.close()
            except Exception:
                pass


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