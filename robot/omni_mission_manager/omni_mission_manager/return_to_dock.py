"""Return-to-dock chain (Phase 3) — pure Python, no ROS.

The chain is orchestrated by the mission manager because it owns the
mission lease and knows when a mission is running:

  PREPARING -> NAVIGATING -> FINAL_APPROACH -> WAITING_CHARGE -> CHARGING
     (1)          (2)              (3)               (4)           (5)

Leg 1 (NAVIGATING): a FollowRoute goal from the robot's current pose to
the dock's standoff point (a synthetic 2-point path; the planner rejects
paths with fewer than 2 waypoints). While this leg is in flight the
manager holds the MISSION lease under the client id "mission-rtd-<san>".

Leg 2 (FINAL_APPROACH / WAITING_CHARGE): the /omni/docking/dock action.
The omni_docking node acquires its own DOCKING lease (client id
"docking-rtd-<san>"), drives the final approach and confirms charging.
The nav-leg lease is released before the dock goal is sent because the
gateway arbiter maps owners 1:1 (MISSION <-> navigation,
DOCKING <-> docking).

Progress is weighted over the whole chain: 0.6 navigation, 0.3 final
approach, 0.1 charge confirmation (constants.RTD_*_WEIGHT).

All decision logic lives here so it is unit-testable without ROS. The
node (mission_manager_node.py) translates between this machine, the
ReturnToDock action server and the FollowRoute/Dock action clients.

This is NOT a MissionMachine mission: it produces no MissionEvent /
MissionStatus, only action feedback.
"""

from . import constants as C


class RtdContext:
    """Robot facts the goal gates need.

    The node builds it from the RobotState subscription (freshness,
    estop, charging, map, localization, and whether a mission is
    active) and the pose subscription (pose_fresh).
    """

    def __init__(self, fresh, estop_latched, charging, map_id,
                 map_version, localization_state, pose_fresh,
                 mission_active):
        self.fresh = fresh
        self.estop_latched = estop_latched
        self.charging = charging
        self.map_id = map_id
        self.map_version = map_version
        self.localization_state = localization_state
        self.pose_fresh = pose_fresh
        self.mission_active = mission_active


def check_goal(request_id, trigger, ctx, busy, replayed, dock_lookup):
    """Return-to-dock goal gates, in contract order:

      empty id -> busy -> replay -> already charging -> estop latched
      -> no current map -> stale robot state -> no current pose ->
      localization not ready -> mission active (a low-battery trigger
      may interrupt the mission instead) -> no dock configured.

    Everything up to the last gate is a cheap in-memory check.
    ``dock_lookup`` is a zero-arg callable (the blocking
    GetDockConfig call, injected by the node) invoked only when every
    earlier gate passed, so a goal rejected earlier never pays for it.
    It must return the standoff point (x, y) or None.

    Returns (accepted, reason_code, reason_text, standoff).
    """
    if not request_id:
        return False, C.RTD_REASON_REJECTED, "empty request id", None
    if busy:
        return (False, C.RTD_REASON_REJECTED,
                "return to dock in progress", None)
    if replayed:
        return (False, C.RTD_REASON_REJECTED,
                "request id already executed", None)
    if ctx.charging:
        return False, C.RTD_REASON_REJECTED, "already charging", None
    if ctx.estop_latched:
        return False, C.RTD_REASON_REJECTED, "estop latched", None
    if not ctx.map_id:
        return False, C.RTD_REASON_REJECTED, "no current map", None
    if not ctx.fresh:
        return False, C.RTD_REASON_REJECTED, "robot state not fresh", None
    if not ctx.pose_fresh:
        return False, C.RTD_REASON_REJECTED, "no current pose", None
    if ctx.localization_state != C.LOC_LOCALIZED:
        return (False, C.RTD_REASON_LOCALIZATION_NOT_READY,
                "localization not ready (state=%d)"
                % ctx.localization_state, None)
    if ctx.mission_active and trigger != C.RTD_TRIGGER_LOW_BATTERY:
        return (False, C.RTD_REASON_MISSION_ACTIVE,
                "a mission is active (only a low-battery return "
                "interrupts it)", None)
    standoff = dock_lookup()
    if standoff is None:
        return (False, C.RTD_REASON_DOCK_NOT_FOUND,
                "no dock configured for map %s" % (ctx.map_id or "?"),
                None)
    return True, C.RTD_REASON_OK, "", standoff


class ReturnToDock:
    """One return-to-dock chain: its phase, progress and terminal
    answer. Mutated only from the executor thread, under the node's
    core lock."""

    def __init__(self, request_id, trigger, interrupted_mission=None):
        self.request_id = request_id
        self.trigger = trigger
        # Mission interrupted by a low-battery return ("" if none).
        self.interrupted_mission = interrupted_mission or ""
        self.state = C.RTD_STATE_PREPARING
        self.detail = ""
        self.terminal = False
        self.success = False
        self.reason_code = 0
        self.reason_text = ""
        self.docked = False
        self.charging = False
        self._nav_progress = 0.0
        self._approach_progress = 0.0

    @property
    def progress(self):
        """Whole-chain progress 0..1 (weights: 0.6 / 0.3 / 0.1)."""
        if self.terminal and self.success:
            return 1.0
        if self.state == C.RTD_STATE_CHARGING:
            return (C.RTD_NAV_WEIGHT + C.RTD_APPROACH_WEIGHT +
                    C.RTD_CHARGE_WEIGHT)
        if self.state == C.RTD_STATE_WAITING_CHARGE:
            return C.RTD_NAV_WEIGHT + C.RTD_APPROACH_WEIGHT
        if self.state == C.RTD_STATE_FINAL_APPROACH:
            return (C.RTD_NAV_WEIGHT +
                    C.RTD_APPROACH_WEIGHT *
                    min(max(self._approach_progress, 0.0), 1.0))
        if self.state == C.RTD_STATE_NAVIGATING:
            return C.RTD_NAV_WEIGHT * min(max(self._nav_progress, 0.0),
                                          1.0)
        return 0.0

    def on_nav_feedback(self, progress, detail):
        """FollowRoute feedback for the nav leg (per-leg progress 0..1)."""
        if self.terminal:
            return
        self.state = C.RTD_STATE_NAVIGATING
        self._nav_progress = float(progress)
        if detail:
            self.detail = detail

    def on_nav_result(self, ok, reason_code, reason_text):
        """The nav leg reached a terminal status. Success moves the
        chain to the dock leg; failure ends it with NAVIGATION_FAILED."""
        if self.terminal:
            return
        if ok:
            self._nav_progress = 1.0
            self.state = C.RTD_STATE_FINAL_APPROACH
            self.detail = ""
        else:
            self._finish(
                False, C.RTD_REASON_NAVIGATION_FAILED,
                "navigation failed: %s"
                % (reason_text or C.rtd_reason_name(reason_code)))

    def on_dock_feedback(self, state, progress, status_text):
        """Dock action feedback (dock-leg states 1..3)."""
        if self.terminal:
            return
        if state == C.DOCK_STATE_WAITING_CHARGE:
            self.state = C.RTD_STATE_WAITING_CHARGE
            self._approach_progress = 1.0
        else:  # DOCK_STATE_ACQUIRING / DOCK_STATE_SERVING
            self.state = C.RTD_STATE_FINAL_APPROACH
            self._approach_progress = float(progress)
        if status_text:
            self.detail = status_text

    def on_dock_result(self, ok, reason_code, reason_text, charging):
        """The dock leg reached a terminal status.

        Reason mapping: the dock's CONTROL_DENIED passes through
        unchanged; every other dock failure is DOCK_FAILED carrying the
        dock's own text (its codes live in a different 3000s slot).
        """
        if self.terminal:
            return
        if ok:
            self.docked = True
            self.charging = bool(charging)
            if self.charging:
                self.state = C.RTD_STATE_CHARGING
                self._finish(True, C.RTD_REASON_OK,
                             "docked and charging")
            else:
                self.state = C.RTD_STATE_WAITING_CHARGE
                self._finish(False, C.RTD_REASON_DOCK_FAILED,
                             "docked but charge was not confirmed")
        elif reason_code == C.DOCK_REASON_CONTROL_DENIED:
            self._finish(False, C.RTD_REASON_CONTROL_DENIED,
                         reason_text or "docking control denied")
        else:
            self._finish(
                False, C.RTD_REASON_DOCK_FAILED,
                "docking failed: %s"
                % (reason_text or C.dock_reason_name(reason_code)))

    def on_lease_lost(self, why):
        """Lease lost / aborted / node shutting down -> ABORTED."""
        if self.terminal:
            return
        self._finish(False, C.RTD_REASON_ABORTED, why or "lease lost")

    def cancel(self, why="canceled by user"):
        """User cancel. Returns (ok, reason_code, reason_text)."""
        if self.terminal:
            return False, self.reason_code, self.reason_text
        self._finish(False, C.RTD_REASON_USER_CANCELED, why)
        return True, C.RTD_REASON_USER_CANCELED, why

    def _finish(self, success, code, text):
        self.terminal = True
        self.success = success
        self.reason_code = code
        self.reason_text = text


class ReturnToDockMachine:
    """Owns the single active chain and per-manager-epoch request-id
    idempotency (in-memory; a node restart clears it, matching the
    "current manager epoch" semantics of the action contract)."""

    def __init__(self):
        self._current = None
        self._executed = set()

    def active(self):
        return self._current

    def was_executed(self, request_id):
        return request_id in self._executed

    def begin(self, request_id, trigger, interrupted_mission=None):
        """Start a chain. Marks the request id as executed: only call
        this once every gate (including the dock lookup and the lease
        acquire) has passed, so a rejected request stays retryable."""
        rtd = ReturnToDock(request_id, trigger, interrupted_mission)
        self._current = rtd
        self._executed.add(request_id)
        return rtd

    def clear(self, request_id):
        """Drop the active chain once its result has been sent."""
        if self._current is not None and \
                self._current.request_id == request_id:
            self._current = None

    def shutdown(self):
        """Node is going away: abort the active chain. The chain stays
        in place — the goal callback reads its terminal answer.
        Returns the chain if one was active (and was aborted), else
        None."""
        rtd = self._current
        if rtd is not None and not rtd.terminal:
            rtd.on_lease_lost("mission manager shutting down")
        return rtd


class LowBatteryTrigger:
    """One-shot low-battery watchdog with hysteresis re-arm.

    Fires once when the battery is at or below the threshold and not
    charging; re-arms only when the robot is charging or the battery
    has recovered above threshold + hysteresis. The caller marks the
    trigger as fired (``mark_fired``) after the send attempt — accepted
    OR rejected — so a rejected return (estop latched, no dock found)
    does not re-fire every second. A threshold <= 0 disables the
    watchdog.
    """

    def __init__(self, threshold_pct, hysteresis_pct=5.0):
        self.threshold = float(threshold_pct)
        self.hysteresis = float(hysteresis_pct)
        self._fired = False

    @property
    def fired(self):
        return self._fired

    def reset(self):
        self._fired = False

    def evaluate(self, percentage, charging):
        """True exactly when the watchdog should fire now. Does not
        mark fired."""
        if self.threshold <= 0.0:
            return False
        # NaN (battery unknown) never fires.
        if percentage is None or percentage != percentage:
            return False
        if charging:
            # On the dock: re-arm.
            self._fired = False
            return False
        if self._fired:
            if percentage >= self.threshold + self.hysteresis:
                self._fired = False
            return False
        return percentage <= self.threshold

    def mark_fired(self):
        self._fired = True