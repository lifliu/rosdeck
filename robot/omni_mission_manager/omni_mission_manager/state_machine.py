"""Mission lifecycle state machine (V1) — pure Python, no ROS imports.

The node layer (mission_manager_node.py) is the only ROS-aware part;
everything it decides is reduced to calls into MissionMachine so the
lifecycle rules are unit-testable off the robot.

Lifecycle (single active mission at a time in V1):

    PENDING --planner EXECUTING feedback--> EXECUTING
    PENDING/EXECUTING --pause cmd--> PAUSED --resume cmd--> EXECUTING
    * --cancel cmd--> CANCELED
    EXECUTING --planner success--> SUCCEEDED
    * --planner failure/lost--> FAILED
    active --restart / shutdown / lease lost--> INTERRUPTED (never auto-resumed)

Idempotency: (request_id, sequence) is the key.
  - same (request_id, sequence) -> duplicate, original result returned;
  - higher sequence, same request_id -> new attempt, old one superseded
    (CANCELED with "superseded by sequence N");
  - lower sequence, same request_id -> REJECTED as stale.

A dispatch aborted before the DISPATCHED event is recorded (planner
unavailable / authority denied) deletes its row and frees the
(request_id, sequence) key, so the App can retry the same key.

Terminal result mapping (goal result / duplicate responses):
  SUCCEEDED   -> success, REASON_OK
  CANCELED    -> !success, REASON_USER_CANCELED
  FAILED      -> !success, REASON_MISSION_FAILED
  INTERRUPTED -> !success, REASON_MISSION_INTERRUPTED
"""

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from . import constants as C
from .checkpoints import (CheckpointsMalformed, CheckpointPlan,
                          CheckpointStore, plan_segments)
from .event_store import EventStore
from .route_store import RouteMalformed, RouteNotFound, RouteStore

__all__ = [
    "DispatchGoal",
    "GoalOutcome",
    "Mission",
    "MissionEventRecord",
    "MissionMachine",
    "RobotStateView",
    "clamp_progress",
]


def clamp_progress(value) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(v):
        return 0.0
    return min(max(v, 0.0), 1.0)


def _default_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


@dataclass
class RobotStateView:
    """Latest /omni/robot_state relevant to the dispatch gates.

    ``fresh`` is False when no RobotState has been seen or the last one is
    stale (the node decides staleness from its own clock).
    """
    fresh: bool
    localization_state: int = C.LOC_UNKNOWN
    map_id: str = ""
    map_version: str = ""


@dataclass(frozen=True)
class DispatchGoal:
    mission_id: str
    request_id: str
    sequence: int
    map_id: str
    map_version: str
    route_id: str
    checkpoint_ids: Tuple[str, ...] = ()


@dataclass
class Mission:
    mission_id: str
    request_id: str
    sequence: int
    route_id: str
    map_id: str
    map_version: str
    state: int
    progress: float
    reason_code: int
    reason_text: str
    status_text: str
    event_seq: int
    created_at: str
    updated_at: str
    terminated_at: Optional[str]
    # In-memory only (never persisted: missions are not auto-resumed).
    # The checkpoint currently running, or "" — surfaced in the
    # ExecuteInspection feedback (current_checkpoint_id, Phase 3).
    current_checkpoint_id: str = ""

    @property
    def authority_client_id(self) -> str:
        return "mission-%s" % self.mission_id

    @property
    def is_active(self) -> bool:
        return self.state in C.ACTIVE_STATES

    @property
    def is_terminal(self) -> bool:
        return self.state in C.TERMINAL_STATES

    @classmethod
    def from_row(cls, row: Dict[str, Any]) -> "Mission":
        return cls(
            mission_id=row["mission_id"],
            request_id=row["request_id"],
            sequence=int(row["sequence"]),
            route_id=row["route_id"],
            map_id=row["map_id"],
            map_version=row["map_version"],
            state=int(row["state"]),
            progress=float(row["progress"]),
            reason_code=int(row["reason_code"]),
            reason_text=row["reason_text"],
            status_text=row["status_text"],
            event_seq=0,  # filled by the machine from the event table
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            terminated_at=row["terminated_at"],
        )


@dataclass(frozen=True)
class MissionEventRecord:
    mission_id: str
    seq: int
    event: int
    mission_state: int
    progress: float
    reason_code: int
    reason_text: str
    created_at: str


@dataclass
class GoalOutcome:
    action: str  # "accept" | "reject" | "duplicate"
    reason_code: int = C.REASON_OK
    reason_text: str = ""
    mission: Optional[Mission] = None
    superseded: Optional[Mission] = None


class MissionMachine:
    """Owns all mission state transitions for one Manager process."""

    def __init__(self, store: EventStore, route_store: RouteStore,
                 now_fn=None, checkpoint_store: Optional[CheckpointStore] = None):
        self._store = store
        self._routes = route_store
        self._checkpoints = checkpoint_store
        self._now = now_fn or _default_now
        self._missions: Dict[str, Mission] = {}
        # Per-mission segment plan (in-memory; the node consumes it to
        # drive FollowRoute leg by leg). Popped on terminal / abort.
        self._plans: Dict[str, CheckpointPlan] = {}
        self._pending_events: List[MissionEventRecord] = []
        for row in self._store.get_all_missions():
            m = Mission.from_row(row)
            m.event_seq = self._store.event_count(m.mission_id)
            self._missions[m.mission_id] = m

    # ---------- accessors ----------

    def get(self, mission_id: str) -> Optional[Mission]:
        return self._missions.get(mission_id)

    def active_mission(self) -> Optional[Mission]:
        for m in self._missions.values():
            if m.is_active:
                return m
        return None

    def drain_events(self) -> List[MissionEventRecord]:
        evs = self._pending_events
        self._pending_events = []
        return evs

    def get_plan(self, mission_id: str) -> Optional[CheckpointPlan]:
        """The mission's segment plan (None once it is terminal/dropped).

        The node builds a SegmentController from it; the plan itself is
        immutable (frozen dataclass), so sharing the reference is safe.
        """
        return self._plans.get(mission_id)

    # ---------- internal helpers ----------

    def _resolve_target(self, mission_id: str) -> Optional[Mission]:
        if not mission_id:
            return self.active_mission()
        m = self._missions.get(mission_id)
        if m is None or not m.is_active:
            return None
        return m

    def _record_event(self, m: Mission, event: int, now: str,
                      reason_code: int = 0, reason_text: str = ""):
        seq = m.event_seq + 1
        self._store.append_event(
            m.mission_id, seq, event, m.state, m.progress,
            reason_code, reason_text, now)
        m.event_seq = seq
        self._pending_events.append(MissionEventRecord(
            mission_id=m.mission_id, seq=seq, event=event,
            mission_state=m.state, progress=m.progress,
            reason_code=reason_code, reason_text=reason_text,
            created_at=now))

    def _persist(self, m: Mission, now: str, terminated: bool = False):
        self._store.update_mission(
            m.mission_id, now, state=m.state, progress=m.progress,
            reason_code=m.reason_code, reason_text=m.reason_text,
            status_text=m.status_text, terminated=terminated)
        m.updated_at = now
        if terminated:
            m.terminated_at = now

    def _terminate(self, m: Mission, state: int, event: int, now: str,
                   reason_code: int, reason_text: str):
        m.state = state
        m.reason_code = reason_code
        m.reason_text = reason_text
        self._record_event(m, event, now, reason_code, reason_text)
        self._persist(m, now, terminated=True)
        m.current_checkpoint_id = ""
        self._plans.pop(m.mission_id, None)

    def _default_mission_id(self, sequence: int, now: str) -> str:
        try:
            dt = datetime.strptime(now, "%Y-%m-%dT%H:%M:%S.%fZ")
        except ValueError:
            dt = datetime.now(timezone.utc)
        return "m%s-%d" % (dt.strftime("%Y%m%d%H%M%S"), sequence)

    def _unique_mission_id(self, base: str) -> str:
        candidate = base
        n = 2
        while (candidate in self._missions
               or self._store.mission_exists(candidate)):
            candidate = "%s-%d" % (base, n)
            n += 1
        return candidate

    # ---------- dispatch ----------

    def dispatch(self, goal: DispatchGoal,
                 robot: RobotStateView) -> GoalOutcome:
        """Run the precondition gates and create/resolve the mission.

        Gate order (fail fast, documented in the IDL):
          request_id -> route exists -> checkpoint selection -> map
          resolution and mismatch -> robot state fresh -> localization
          ready -> idempotency / active-mission checks -> create.
        """
        # --- precondition gates (fail fast) ---
        if not goal.request_id:
            return GoalOutcome(
                "reject", C.REASON_REJECTED, "request_id is required")
        try:
            route = self._routes.load(goal.route_id)
        except RouteNotFound:
            return GoalOutcome(
                "reject", C.REASON_ROUTE_NOT_FOUND,
                "route not found: %s" % goal.route_id)
        except RouteMalformed as exc:
            return GoalOutcome(
                "reject", C.REASON_ROUTE_NOT_FOUND,
                "route unreadable: %s" % exc)

        # --- checkpoint selection (Phase 3) ---
        # Empty goal.checkpoint_ids + a sidecar present -> run all defined
        # checkpoints; a non-empty list selects that exact subset (unknown
        # ids are a dispatch-time reject). No sidecar -> no checkpoints
        # (V1 single-segment behavior); a non-empty list then names unknown
        # ids and is rejected the same way. A malformed sidecar fails
        # closed: the mission is rejected, never run without its
        # checkpoints.
        try:
            defined = (self._checkpoints.load(goal.route_id)
                       if self._checkpoints is not None else ())
        except CheckpointsMalformed as exc:
            return GoalOutcome(
                "reject", C.REASON_ROUTE_NOT_FOUND,
                "route checkpoints unreadable: %s" % exc)
        selected = list(defined)
        if goal.checkpoint_ids:
            known = {cp.id for cp in defined}
            unknown = [cid for cid in goal.checkpoint_ids if cid not in known]
            if unknown:
                return GoalOutcome(
                    "reject", C.REASON_REJECTED,
                    "unknown checkpoint id(s): %s" % ", ".join(unknown))
            selected = [cp for cp in defined
                        if cp.id in set(goal.checkpoint_ids)]

        # Map resolution: goal > route binding (sidecar). An empty goal
        # field falls back to the route's binding; an empty map_version
        # means "current version". Unbound routes (no sidecar) leave the
        # effective identity to the goal alone, as before.
        if goal.map_id and route.map_id and goal.map_id != route.map_id:
            return GoalOutcome(
                "reject", C.REASON_MAP_MISMATCH,
                "route %s is bound to map %s, goal requests %s"
                % (goal.route_id, route.map_id, goal.map_id))
        effective_map = goal.map_id or route.map_id
        effective_version = goal.map_version or route.map_version

        if not robot.fresh:
            return GoalOutcome(
                "reject", C.REASON_LOCALIZATION_NOT_READY,
                "no fresh robot state")
        if robot.map_id and effective_map and robot.map_id != effective_map:
            return GoalOutcome(
                "reject", C.REASON_MAP_MISMATCH,
                "robot is localized on map %s, mission requests %s"
                % (robot.map_id, effective_map))
        if (effective_version and robot.map_version
                and robot.map_version != effective_version):
            return GoalOutcome(
                "reject", C.REASON_MAP_MISMATCH,
                "robot map version %s != requested %s"
                % (robot.map_version, effective_version))
        if robot.localization_state != C.LOC_LOCALIZED:
            text = "localization not ready (state=%d" % robot.localization_state
            if effective_map:
                text += " on map %s" % effective_map
            text += ")"
            return GoalOutcome(
                "reject", C.REASON_LOCALIZATION_NOT_READY, text)

        # --- idempotency ---
        existing_id = self._store.lookup_mission_id(
            goal.request_id, goal.sequence)
        if existing_id:
            m = self._missions.get(existing_id)
            if m is not None:
                return GoalOutcome("duplicate", mission=m)
            # Row vanished (should not happen); fall through to create.

        active = self.active_mission()
        superseded: Optional[Mission] = None
        if active is not None:
            if active.request_id == goal.request_id \
                    and goal.sequence > active.sequence:
                # Supersede: the older attempt of the same request is
                # canceled and the new one proceeds.
                superseded = active
                self._terminate(
                    active, C.MISSION_CANCELED, C.EVENT_CANCELED, self._now(),
                    C.REASON_USER_CANCELED,
                    "superseded by sequence %d" % goal.sequence)
            elif active.request_id == goal.request_id:
                return GoalOutcome(
                    "reject", C.REASON_REJECTED,
                    "stale sequence %d (active is %d)"
                    % (goal.sequence, active.sequence))
            else:
                return GoalOutcome(
                    "reject", C.REASON_REJECTED,
                    "another mission is active: %s" % active.mission_id)

        # --- create ---
        now = self._now()
        base = goal.mission_id or self._default_mission_id(goal.sequence, now)
        if not base:
            return GoalOutcome(
                "reject", C.REASON_REJECTED, "cannot generate mission_id")
        if goal.mission_id and (
                goal.mission_id in self._missions
                or self._store.mission_exists(goal.mission_id)):
            return GoalOutcome(
                "reject", C.REASON_REJECTED,
                "mission_id already exists: %s" % goal.mission_id)
        mission_id = self._unique_mission_id(base)
        mission = Mission(
            mission_id=mission_id,
            request_id=goal.request_id,
            sequence=int(goal.sequence),
            route_id=goal.route_id,
            map_id=effective_map,
            map_version=effective_version,
            state=C.MISSION_PENDING,
            progress=0.0,
            reason_code=0,
            reason_text="",
            status_text="",
            event_seq=0,
            created_at=now,
            updated_at=now,
            terminated_at=None,
        )
        self._missions[mission_id] = mission
        self._store.begin_mission(
            mission_id, goal.request_id, goal.sequence, goal.route_id,
            effective_map, effective_version, now)
        # Segment plan: one FollowRoute leg per checkpoint interval. With
        # no checkpoints this is a single full-route leg (V1 behavior).
        self._plans[mission_id] = plan_segments(route.num_points, selected)
        return GoalOutcome("accept", mission=mission, superseded=superseded)

    def abort_created(self, mission_id: str, reason_code: int,
                      reason_text: str) -> None:
        """Drop a mission that was created but never dispatched (no
        DISPATCHED event): planner unavailable or authority denied. The
        (request_id, sequence) key is freed for retry."""
        self._missions.pop(mission_id, None)
        self._plans.pop(mission_id, None)
        self._store.delete_mission(mission_id)

    def confirm_dispatch(self, mission_id: str) -> Optional[Mission]:
        """Record the DISPATCHED event once the planner goal is in flight.

        A mission that is no longer PENDING (canceled in the meantime)
        stays as-is.
        """
        m = self._missions.get(mission_id)
        if m is None or m.state != C.MISSION_PENDING:
            return m
        self._record_event(m, C.EVENT_DISPATCHED, self._now())
        self._persist(m, self._now())
        return m

    # ---------- planner feedback / result ----------

    def on_planner_feedback(self, mission_id: str, state: int, progress,
                            status_text: str = "") -> None:
        m = self._missions.get(mission_id)
        if m is None or not m.is_active:
            return
        now = self._now()
        m.progress = clamp_progress(progress)
        if status_text:
            m.status_text = status_text
        started = False
        if m.state == C.MISSION_PENDING \
                and state == C.PLANNER_STATE_EXECUTING:
            m.state = C.MISSION_EXECUTING
            started = True
        if started:
            self._record_event(m, C.EVENT_STARTED, now)
        self._persist(m, now)

    def on_planner_result(self, mission_id: str, success: bool,
                          reason_code: int, reason_text: str,
                          final_progress) -> Optional[Mission]:
        m = self._missions.get(mission_id)
        if m is None or not m.is_active:
            return None
        now = self._now()
        if success and reason_code == C.PLANNER_REASON_OK:
            m.progress = clamp_progress(final_progress)
            self._terminate(
                m, C.MISSION_SUCCEEDED, C.EVENT_SUCCEEDED, now,
                C.REASON_OK,
                reason_text or "route completed")
        elif reason_code == C.PLANNER_REASON_USER_CANCELED \
                and m.state == C.MISSION_CANCELED:
            return None  # already terminated by our cancel path
        else:
            m.progress = clamp_progress(final_progress)
            text = "planner: %s" % C.planner_reason_name(reason_code)
            if reason_text:
                text += " (%s)" % reason_text
            self._terminate(
                m, C.MISSION_FAILED, C.EVENT_FAILED, now,
                C.REASON_MISSION_FAILED, text)
        return m

    def on_planner_rejected(self, mission_id: str,
                            reason_text: str) -> Optional[Mission]:
        m = self._missions.get(mission_id)
        if m is None or not m.is_active:
            return None
        self._terminate(
            m, C.MISSION_FAILED, C.EVENT_FAILED, self._now(),
            C.REASON_MISSION_FAILED,
            "planner rejected goal: %s" % (reason_text or "no reason"))
        return m

    def on_planner_lost(self, mission_id: str,
                        reason_text: str = "planner goal lost") -> \
            Optional[Mission]:
        """The FollowRoute goal is gone (server died / canceled without a
        result) while the mission is still active."""
        m = self._missions.get(mission_id)
        if m is None or not m.is_active:
            return None
        self._terminate(
            m, C.MISSION_FAILED, C.EVENT_FAILED, self._now(),
            C.REASON_MISSION_FAILED, reason_text)
        return m

    # ---------- checkpoints (Phase 3) ----------

    def on_checkpoint_started(self, mission_id: str,
                              checkpoint_id: str) -> None:
        """The robot is at the checkpoint and its actions are starting.

        A mission that has not reached planner EXECUTING yet (e.g. a
        checkpoint at route point 0) starts here.
        """
        m = self._missions.get(mission_id)
        if m is None or not m.is_active:
            return
        now = self._now()
        m.current_checkpoint_id = checkpoint_id
        started = False
        if m.state == C.MISSION_PENDING:
            m.state = C.MISSION_EXECUTING
            started = True
        if started:
            self._record_event(m, C.EVENT_STARTED, now)
        self._persist(m, now)

    def on_checkpoint_finished(self, mission_id: str) -> None:
        m = self._missions.get(mission_id)
        if m is None or not m.is_active:
            return
        if m.current_checkpoint_id:
            m.current_checkpoint_id = ""
            self._persist(m, self._now())

    def on_checkpoint_failed(self, mission_id: str, checkpoint_id: str,
                             reason: str) -> Optional[Mission]:
        """A checkpoint's `on_failure` is "fail" and its evidence actions
        exhausted their attempts: the mission ends FAILED."""
        m = self._missions.get(mission_id)
        if m is None or not m.is_active:
            return None
        self._terminate(
            m, C.MISSION_FAILED, C.EVENT_FAILED, self._now(),
            C.REASON_MISSION_FAILED,
            "checkpoint %s failed: %s" % (checkpoint_id, reason))
        return m

    # ---------- MissionControl ----------

    def cancel(self, mission_id: str) -> Tuple[bool, int, str]:
        m = self._resolve_target(mission_id)
        if m is None:
            return False, C.REASON_REJECTED, "no active mission"
        self._terminate(
            m, C.MISSION_CANCELED, C.EVENT_CANCELED, self._now(),
            C.REASON_USER_CANCELED,
            "canceled by user" if not mission_id
            else "canceled by user (%s)" % mission_id)
        return True, C.REASON_OK, ""

    def pause(self, mission_id: str) -> Tuple[bool, int, str]:
        m = self._resolve_target(mission_id)
        if m is None:
            return False, C.REASON_REJECTED, "no active mission"
        if m.state in (C.MISSION_PENDING, C.MISSION_EXECUTING):
            now = self._now()
            m.state = C.MISSION_PAUSED
            self._record_event(m, C.EVENT_PAUSED, now)
            self._persist(m, now)
            return True, C.REASON_OK, ""
        return False, C.REASON_REJECTED, \
            "mission is not pausable (state=%d)" % m.state

    def begin_resume(self, mission_id: str) -> Tuple[bool, int, str]:
        """Validate only; the node re-acquires the lease and calls
        finish_resume. Kept separate so a denied re-acquire leaves the
        mission paused."""
        m = self._resolve_target(mission_id)
        if m is None:
            return False, C.REASON_REJECTED, "no active mission"
        if m.state == C.MISSION_PAUSED:
            return True, C.REASON_OK, ""
        return False, C.REASON_REJECTED, \
            "mission is not paused (state=%d)" % m.state

    def finish_resume(self, mission_id: str) -> Optional[Mission]:
        m = self._missions.get(mission_id)
        if m is None or m.state != C.MISSION_PAUSED:
            return m
        now = self._now()
        m.state = C.MISSION_EXECUTING
        self._record_event(m, C.EVENT_RESUMED, now)
        self._persist(m, now)
        return m

    # ---------- interruptions ----------

    def on_authority_lost(self, reason_text: str) -> Optional[Mission]:
        """The mission lease was preempted (App takeover) or failed to
        renew. Paused missions hold no lease and are untouched."""
        m = self.active_mission()
        if m is None or m.state == C.MISSION_PAUSED:
            return None
        self._terminate(
            m, C.MISSION_INTERRUPTED, C.EVENT_INTERRUPTED, self._now(),
            C.REASON_MISSION_INTERRUPTED, reason_text)
        return m

    def recover_on_startup(self) -> List[Mission]:
        """Rows still active from a previous process (crash / kill
        without graceful shutdown) become INTERRUPTED. Missions are never
        auto-resumed."""
        out: List[Mission] = []
        for row in self._store.list_active_missions():
            m = self._missions.get(row["mission_id"])
            if m is None or not m.is_active:
                continue
            self._terminate(
                m, C.MISSION_INTERRUPTED, C.EVENT_INTERRUPTED, self._now(),
                C.REASON_MISSION_INTERRUPTED,
                "mission manager restarted; mission not auto-resumed")
            out.append(m)
        return out

    def shutdown(self) -> List[Mission]:
        """Graceful stop: everything still active (including PAUSED)
        becomes INTERRUPTED so the next startup does not carry it over."""
        out: List[Mission] = []
        for m in list(self._missions.values()):
            if m.is_active:
                self._terminate(
                    m, C.MISSION_INTERRUPTED, C.EVENT_INTERRUPTED,
                    self._now(),
                    C.REASON_MISSION_INTERRUPTED,
                    "mission manager shutting down")
                out.append(m)
        return out

    # ---------- output ----------

    def terminal_result(self, m: Mission) -> Tuple[bool, int, str, float]:
        """(success, reason_code, reason_text, final_progress) for a
        terminal mission, or an in-flight duplicate answer for an active
        one."""
        if m.state == C.MISSION_SUCCEEDED:
            return True, C.REASON_OK, m.reason_text or "mission completed", \
                m.progress
        if m.state == C.MISSION_CANCELED:
            return False, C.REASON_USER_CANCELED, m.reason_text, m.progress
        if m.state == C.MISSION_FAILED:
            return False, C.REASON_MISSION_FAILED, m.reason_text, m.progress
        if m.state == C.MISSION_INTERRUPTED:
            return False, C.REASON_MISSION_INTERRUPTED, m.reason_text, \
                m.progress
        return False, C.REASON_DUPLICATE, "mission in progress", m.progress

    def snapshot(self) -> Mission:
        """The mission to advertise on /omni/mission/status, or a
        synthetic NONE row."""
        m = self.active_mission()
        if m is not None:
            return m
        return Mission(
            mission_id="", request_id="", sequence=0, route_id="",
            map_id="", map_version="", state=C.MISSION_NONE, progress=0.0,
            reason_code=0, reason_text="", status_text="", event_seq=0,
            created_at="", updated_at="", terminated_at=None)