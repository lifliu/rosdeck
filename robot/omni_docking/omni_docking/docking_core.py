"""Pure docking operation state machine (no rclpy).

The node flattens its subscriptions into a :class:`DockSnapshot` and
calls :meth:`DockingCore.update` at the servo rate (20 Hz); the core
answers with an :class:`OpEvent` (twist / authority commands / feedback
/ terminal). All time is the monotonic ``now`` the node passes in, so
the core is deterministically testable.

Op lifecycle:
  gate (start) -> ACQUIRING -> SERVING -> WAITING_CHARGE -> terminal
                                  (dock)
  gate         -> ACQUIRING -> MOVING -> terminal
                                  (undock)

Failure policy: any gate failure or mid-op fault terminates the op with
a single diagnostic reason; the core never retries on its own
(acceptance criterion: failures are diagnosable and never loop).
Lease loss, stale pose, stale robot state and E-stop all abort. The
lease is always released on terminal and velocity is always zeroed.
"""

import math

from . import authority
from . import constants as C
from .approach import ApproachController, UndockController


OP_DOCK = "dock"
OP_UNDOCK = "undock"

PH_ACQUIRING = "acquiring"
PH_SERVING = "serving"
PH_WAITING_CHARGE = "waiting_charge"
PH_MOVING = "moving"

# How close the robot must be to count as physically docked for the
# DockStatus CHARGING/DOCKED detection (tighter than the undock gate).
DOCKED_RADIUS_M = 0.3


class DockSnapshot:
    """Per-tick input to the core (the node builds it)."""

    __slots__ = ("now", "robot_fresh", "estop_latched", "localization_state",
                 "map_id", "map_version", "pose", "control_status")

    def __init__(self, now, robot_fresh, estop_latched, localization_state,
                 map_id="", map_version="", pose=None, control_status=""):
        self.now = now
        self.robot_fresh = robot_fresh
        self.estop_latched = estop_latched
        self.localization_state = localization_state
        self.map_id = map_id
        self.map_version = map_version
        self.pose = pose
        self.control_status = control_status


class OpEvent:
    """Per-tick output of the core (the node acts on it)."""

    __slots__ = ("twist", "acquire", "heartbeat", "release", "feedback",
                 "terminal")

    def __init__(self):
        self.twist = None          # (linear, angular) or None
        self.acquire = False       # publish acquire:<client_id>
        self.heartbeat = False     # publish heartbeat:<client_id>
        self.release = False       # publish release:<client_id>
        self.feedback = None       # (state, progress, text)
        self.terminal = None       # (success, code, text, extra dict)


class _Op:
    __slots__ = ("kind", "request_id", "client_id", "dock", "phase",
                 "started_at", "phase_started_at", "acquire_sent",
                 "acquired", "last_heartbeat_at", "lease_lost_at",
                 "pose_seen_at", "state_lost_at", "approach", "undock",
                 "cancel_requested", "result")

    def __init__(self, kind, request_id, client_id, dock):
        self.kind = kind
        self.request_id = request_id
        self.client_id = client_id
        self.dock = dock
        self.phase = PH_ACQUIRING
        self.started_at = None
        self.phase_started_at = None
        self.acquire_sent = False
        self.acquired = False
        self.last_heartbeat_at = None
        self.lease_lost_at = None
        self.pose_seen_at = None
        self.state_lost_at = None
        self.approach = None
        self.undock = None
        self.cancel_requested = False
        self.result = None


class DockingCore:
    """One active docking op at a time; see module docstring."""

    def __init__(self, store, charge_monitor, params):
        self.store = store
        self.charge = charge_monitor
        self.p = dict(params)
        self._op = None
        self._last_terminal = None  # {"success", "code", "text", "kind"}
        self._dock_error_m = None   # last measured distance to the dock

    # ------------------------------------------------------------------ #
    # start / gates
    # ------------------------------------------------------------------ #

    def start(self, kind, request_id, snap):
        """Gate and open an op. Returns (ok, reason_code, reason_text)."""
        if self._op is not None:
            return (False, C.REASON_REJECTED,
                    "another docking op is active ({})".format(
                        self._op.request_id))
        if not snap.robot_fresh:
            return (False, C.REASON_REJECTED, "robot state stale")
        if snap.estop_latched:
            return (False, C.REASON_REJECTED, "estop latched")
        if snap.localization_state != C.LOC_LOCALIZED:
            return (False, C.REASON_LOCALIZATION_LOST,
                    "localization not ready (state={})".format(
                        snap.localization_state))
        cfg = self.store.look_up(snap.map_id, snap.map_version)
        if cfg is None:
            return (False, C.REASON_DOCK_NOT_FOUND,
                    "no dock configured for map {!r} version {!r}".format(
                        snap.map_id, snap.map_version))
        if snap.pose is None:
            if kind == OP_UNDOCK:
                return (False, C.REASON_REJECTED,
                        "no pose; cannot confirm the robot is at the dock")
            # dock: the pose gate is enforced in SERVING (the robot may
            # be waiting at the standoff while localization settles)
        else:
            if kind == OP_UNDOCK and \
                    cfg.pose.distance(snap.pose) > cfg.at_dock_tolerance:
                return (False, C.REASON_REJECTED,
                        "not at the dock ({:.2f} m away)".format(
                            cfg.pose.distance(snap.pose)))
        try:
            client_id = authority.make_client_id(request_id)
        except ValueError as exc:
            return (False, C.REASON_REJECTED, "invalid request_id: {}".format(exc))

        op = _Op(kind, request_id, client_id, cfg)
        op.started_at = snap.now
        op.phase_started_at = snap.now
        if kind == OP_DOCK:
            op.approach = self._make_approach(cfg)
        else:
            op.undock = UndockController(
                cfg.pose,
                yaw_tolerance=self.p.get("yaw_tolerance", 0.25),
                standoff_speed=self.p.get("standoff_speed", 0.15),
            )
        self._op = op
        self._dock_error_m = (cfg.pose.distance(snap.pose)
                              if snap.pose is not None else None)
        return (True, C.REASON_OK, "accepted")

    def _make_approach(self, cfg):
        return ApproachController(
            cfg.pose,
            pos_tolerance=self.p.get("pos_tolerance", 0.15),
            yaw_tolerance=self.p.get("yaw_tolerance", 0.25),
            standoff_speed=self.p.get("standoff_speed", 0.15),
            final_speed=self.p.get("final_speed", 0.05),
        )

    # ------------------------------------------------------------------ #
    # per-tick update
    # ------------------------------------------------------------------ #

    def update(self, snap):
        op = self._op
        ev = OpEvent()
        if op is None or op.result is not None:
            return ev  # idle, or terminal already delivered; finish() clears
        now = snap.now

        # 1. cancel (checked first: the user wins over everything)
        if op.cancel_requested:
            self._terminate(op, C.REASON_USER_CANCELED,
                            "canceled by request", success=False)
            return self._terminal_event(op, ev)

        # 2. E-stop latched at any phase: stop, zero, release.
        if snap.estop_latched:
            self._terminate(op, C.REASON_ABORTED,
                            "estop latched during {}".format(op.phase))
            return self._terminal_event(op, ev)

        # 3. robot state freshness (estop/localization inputs are stale)
        if not snap.robot_fresh:
            if op.state_lost_at is None:
                op.state_lost_at = now
            elif now - op.state_lost_at > self.p.get("state_stale_sec", 2.0):
                self._terminate(op, C.REASON_ABORTED,
                                "robot state stream stale")
                return self._terminal_event(op, ev)
        else:
            op.state_lost_at = None

        # 4. lease maintenance (once acquired)
        if op.acquired:
            if authority.holding(snap.control_status, op.client_id):
                op.lease_lost_at = None
                if op.last_heartbeat_at is None or \
                        now - op.last_heartbeat_at >= C.HEARTBEAT_PERIOD_SEC:
                    ev.heartbeat = True
                    op.last_heartbeat_at = now
            else:
                if op.lease_lost_at is None:
                    op.lease_lost_at = now
                elif now - op.lease_lost_at > C.LEASE_LOST_GRACE_SEC:
                    self._terminate(
                        op, C.REASON_ABORTED,
                        "control lease lost (status={!r})".format(
                            snap.control_status))
                    return self._terminal_event(op, ev)

        # 5. phase logic
        if op.phase == PH_ACQUIRING:
            if not op.acquire_sent:
                op.acquire_sent = True
                ev.acquire = True
            if authority.holding(snap.control_status, op.client_id):
                op.acquired = True
                op.last_heartbeat_at = now
                op.phase = PH_SERVING if op.kind == OP_DOCK else PH_MOVING
                op.phase_started_at = now
            elif now - op.started_at > C.ACQUIRE_TIMEOUT_SEC:
                self._terminate(
                    op, C.REASON_CONTROL_DENIED,
                    "DOCKING lease not granted in {:.0f}s (status={!r})".format(
                        C.ACQUIRE_TIMEOUT_SEC, snap.control_status))
                return self._terminal_event(op, ev)
            ev.twist = (0.0, 0.0)
            ev.feedback = self._feedback(op, 0.0, "acquiring DOCKING lease")
            return ev

        if op.phase == PH_SERVING or op.phase == PH_MOVING:
            # Captured up front: a dock op flips to WAITING_CHARGE on
            # the done tick and must not be treated as undock feedback.
            is_serving = op.phase == PH_SERVING
            timeout_key = "approach_timeout_sec" if is_serving \
                else "move_timeout_sec"
            reason_code = (C.REASON_APPROACH_TIMEOUT if is_serving
                           else C.REASON_MOVE_TIMEOUT)

            pose = snap.pose
            if pose is not None:
                op.pose_seen_at = now
                if op.phase == PH_SERVING:
                    tick = op.approach.step(pose)
                    ev.twist = (tick.linear, tick.angular)
                    self._dock_error_m = tick.remaining
                    if tick.done:
                        op.phase = PH_WAITING_CHARGE
                        op.phase_started_at = now
                        self._dock_error_m = 0.0
                else:
                    tick = op.undock.step(pose)
                    ev.twist = (tick.linear, tick.angular)
                    self._dock_error_m = tick.clearance
                    if tick.done:
                        self._terminate(
                            op, C.REASON_OK,
                            "undocked, clearance {:.2f} m".format(
                                tick.clearance),
                            success=True,
                            extra={"clearance_m": tick.clearance})
                        return self._terminal_event(op, ev)
            else:
                ev.twist = (0.0, 0.0)
                if op.pose_seen_at is None and \
                        now - op.phase_started_at > \
                        self.p.get("pose_start_timeout_sec", 5.0):
                    self._terminate(op, C.REASON_ABORTED,
                                    "pose stream not available")
                    return self._terminal_event(op, ev)

            if op.pose_seen_at is not None and \
                    now - op.pose_seen_at > self.p.get("pose_stale_sec", 1.0):
                self._terminate(op, C.REASON_ABORTED, "pose stream stale")
                return self._terminal_event(op, ev)

            if now - op.phase_started_at > self.p.get(timeout_key, 45.0):
                self._terminate(op, reason_code,
                                "{} timed out after {:.0f}s".format(
                                    op.phase, self.p.get(timeout_key, 45.0)))
                return self._terminal_event(op, ev)

            if is_serving:
                progress = 0.0
                if op.approach._initial_remaining:
                    progress = min(
                        1.0, 1.0 - self._dock_error_m /
                        max(op.approach._initial_remaining, 1e-6))
                ev.feedback = self._feedback(
                    op, progress, "servoing to dock ({:.2f} m left)".format(
                        self._dock_error_m or 0.0))
            else:
                progress = 0.0
                span = max(op.undock.dock.approach_distance, 1e-6)
                progress = min(1.0, (self._dock_error_m or 0.0) / span)
                ev.feedback = self._feedback(
                    op, progress, "backing off the dock ({:.2f} m)".format(
                        self._dock_error_m or 0.0))
            return ev

        if op.phase == PH_WAITING_CHARGE:
            ev.twist = (0.0, 0.0)
            verdict = self.charge.verify(now)
            if verdict.ok and verdict.charging:
                self._terminate(op, C.REASON_OK,
                                "docked and charging: {}".format(verdict.message),
                                success=True, extra={"charging": True})
                return self._terminal_event(op, ev)
            if now - op.phase_started_at > self.p.get("charge_window_sec", 30.0):
                self._terminate(
                    op, C.REASON_CHARGE_NOT_CONFIRMED,
                    "docked, charging not confirmed (last: {})".format(
                        verdict.message),
                    success=False, extra={"charging": False})
                return self._terminal_event(op, ev)
            ev.feedback = self._feedback(
                op, 1.0,
                "docked, waiting for charge confirmation ({})".format(
                    verdict.message))
            return ev

        return ev

    # ------------------------------------------------------------------ #
    # control / introspection
    # ------------------------------------------------------------------ #

    def request_cancel(self, request_id):
        """Arm a cancel for the active op (finalized on the next tick)."""
        op = self._op
        if op is None or op.result is not None:
            return False
        if op.request_id != request_id:
            return False
        op.cancel_requested = True
        return True

    def finish(self):
        """Drop a terminated op (the node calls this after finalizing the
        action goal)."""
        self._op = None

    @property
    def active(self):
        return self._op if self._op is not None and self._op.result is None \
            else None

    @property
    def last_terminal(self):
        return dict(self._last_terminal) if self._last_terminal else None

    def _feedback(self, op, progress, text):
        if op.kind == OP_DOCK:
            state = {PH_ACQUIRING: C.DOCK_FB_ACQUIRING,
                     PH_SERVING: C.DOCK_FB_SERVING,
                     PH_WAITING_CHARGE: C.DOCK_FB_WAITING_CHARGE}[op.phase]
        else:
            state = {PH_ACQUIRING: C.UNDOCK_FB_ACQUIRING,
                     PH_MOVING: C.UNDOCK_FB_MOVING}[op.phase]
        return (state, float(progress), text)

    def _terminate(self, op, code, text, success=False, extra=None):
        op.result = {"success": success, "code": code, "text": text,
                     "extra": extra or {}}
        self._last_terminal = {"success": success, "code": code,
                               "text": text, "kind": op.kind}

    def _terminal_event(self, op, ev):
        ev.twist = (0.0, 0.0)
        if op.acquired:
            ev.release = True
        ev.terminal = (op.result["success"], op.result["code"],
                       op.result["text"], op.result["extra"])
        return ev

    # ------------------------------------------------------------------ #
    # status
    # ------------------------------------------------------------------ #

    def status_view(self, snap):
        """DockStatus fields (the node fills header/transport)."""
        now = snap.now
        cfg = self.store.look_up(snap.map_id, snap.map_version)
        sample = self.charge.sample
        verdict = self.charge.verify(now) if sample is not None else None
        charging = bool(verdict is not None and verdict.ok and verdict.charging)
        percentage = (sample.percentage if sample is not None
                      and not math.isnan(sample.percentage) else math.nan)

        dock_err = self._dock_error_m
        if dock_err is None and cfg is not None and snap.pose is not None:
            dock_err = cfg.pose.distance(snap.pose)

        op = self.active
        last = self._last_terminal
        if op is not None:
            if authority.is_return_chain(op.client_id):
                state = C.STATE_RETURNING
            elif op.kind == OP_UNDOCK:
                state = C.STATE_UNDOCKING
            else:
                state = C.STATE_FINAL_APPROACH
        elif cfg is not None and snap.pose is not None and \
                dock_err is not None and dock_err <= DOCKED_RADIUS_M:
            state = C.STATE_CHARGING if charging else C.STATE_DOCKED
        elif last is not None and not last["success"]:
            state = C.STATE_FAULT
        else:
            state = C.STATE_IDLE

        return {
            "state": state,
            "dock_id": cfg.dock_id if cfg is not None else "",
            "map_id": snap.map_id,
            "map_version": snap.map_version,
            "charging": charging,
            "battery_percentage": percentage,
            "dock_pose_error_m": float(dock_err) if dock_err is not None
            else math.nan,
            "last_reason_code": last["code"] if last else 0,
            "last_reason_text": last["text"] if last else "",
        }