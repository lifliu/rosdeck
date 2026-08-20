"""Per-mission segment/checkpoint orchestration state (pure, no ROS).

The mission manager never sends one whole-route FollowRoute goal when a
route has checkpoints: it walks the CheckpointPlan leg by leg. This module
is that walk, kept pure so it is unit-testable; the node layer is a thin
adapter that executes what the controller asks for (send a goal, start a
checkpoint worker, finish the mission).

Why the planner sees a distinct mission_id per segment: the planner's
FollowRoute server dedups by mission_id across the whole planner lifetime
(a mission id that reached a terminal result is rejected as a replay). Each
segment attempt therefore sends
    <mission_id>-s<segidx>-a<attempt>
which is unique per segment/attempt even if the mission is re-planned.

A checkpoint rides on the leg that ENDS at its route point (see
checkpoints.plan_segments): when the robot arrives at the leg's end it
stops, runs the checkpoint's actions in a worker thread, then drives the
next leg. A zero-length leg (a checkpoint at the robot's current point)
runs its checkpoint without driving at all.

Phases (controller.state.phase):
    idle        -> before the first leg (initial() picks it up)
    moving      -> a FollowRoute goal for the current leg is in flight
    checkpoint  -> robot at the leg's end, running its actions in a worker
    done        -> every leg finished (or parked after a failure)

Advance signalling: the node's 1 s timer polls ``state.advance_request``
and, when set, calls ``consume_advance()`` to get the next action. Every
asynchronous transition (a leg's terminal result, a checkpoint worker
finishing) sets the flag; the node acts on it on the executor thread. The
worker itself never drives the node — it only calls
``checkpoint_finished()`` under the node's core lock.
"""

from dataclasses import dataclass, field
from typing import Optional, Tuple

from .checkpoints import (CheckpointPlan, Segment, checkpoint_progress,
                          segment_progress)

PHASE_IDLE = "idle"
PHASE_MOVING = "moving"
PHASE_CHECKPOINT = "checkpoint"
PHASE_DONE = "done"

# What the node should do next (returned by initial/consume_advance).
NEXT_SEND = "send"            # send a FollowRoute goal for the current leg
NEXT_CHECKPOINT = "checkpoint"  # start the checkpoint worker for the current leg
NEXT_DONE = "done"            # no more legs; finish the mission


@dataclass
class SegmentState:
    plan: CheckpointPlan
    idx: int = 0                       # current leg index
    attempt: int = 1                   # always 1 in V1 (no leg retry)
    phase: str = PHASE_IDLE
    # Set when an async transition is pending; the node's timer consumes it
    # via consume_advance().
    advance_request: bool = field(default=False)
    # Set by the worker thread when a checkpoint finished with a failure.
    checkpoint_failed: Optional[str] = None   # failure reason, None = ok/none

    @property
    def num_points(self) -> int:
        return self.plan.num_points

    @property
    def current(self) -> Segment:
        return self.plan.segments[self.idx]


class SegmentController:
    """One instance per active mission, owned by the node (locked)."""

    def __init__(self, plan: CheckpointPlan):
        if not plan.segments:
            raise ValueError("plan must have at least one segment")
        self._state = SegmentState(plan=plan)

    # -- introspection -----------------------------------------------------

    @property
    def state(self) -> SegmentState:
        return self._state

    def planner_goal_id(self, mission_id: str) -> str:
        st = self._state
        return "%s-s%d-a%d" % (mission_id, st.idx, st.attempt)

    def progress(self, feedback_progress: float) -> float:
        """Overall route progress for mission-status publishing."""
        st = self._state
        if st.phase == PHASE_DONE:
            return 1.0
        if st.phase == PHASE_CHECKPOINT:
            return checkpoint_progress(st.current, st.num_points)
        if st.idx >= len(st.plan.segments):
            return 1.0
        return segment_progress(st.current, feedback_progress, st.num_points)

    # -- entry points (called on the node's executor thread) -----------------

    def initial(self) -> Tuple[str, Optional[Segment]]:
        """First leg after dispatch: set the phase and return the action.

        The caller acts on the returned action directly (no advance flag —
        that one is only for asynchronous transitions), so the node's timer
        cannot fire the same leg twice.
        """
        self._begin_current()
        return self._next_action()

    def on_goal_sent(self):
        st = self._state
        if st.phase != PHASE_MOVING:
            raise RuntimeError("on_goal_sent outside moving phase (%s)"
                               % st.phase)

    def on_segment_result(self, success: bool):
        """The current leg's FollowRoute goal reached a terminal result.

        Success -> the robot is at the leg's end: run its checkpoint (if it
        has one) or advance to the next leg. Failure -> the node takes the
        mission to FAILED; the controller just parks itself so no new leg
        can start. In all cases the timer is signalled to proceed.
        """
        st = self._state
        if st.phase != PHASE_MOVING:
            raise RuntimeError("on_segment_result outside moving phase (%s)"
                               % st.phase)
        if not success:
            st.phase = PHASE_DONE
        elif st.current.checkpoint_id:
            # Arrived at the checkpoint's point: stop and run it in place.
            st.phase = PHASE_CHECKPOINT
        else:
            self._advance()
        st.advance_request = True

    def checkpoint_finished(self, failed_reason: Optional[str] = None):
        """Worker thread: the current checkpoint's actions all finished."""
        st = self._state
        if st.phase != PHASE_CHECKPOINT:
            raise RuntimeError("checkpoint_finished outside checkpoint phase "
                               "(%s)" % st.phase)
        if failed_reason is not None:
            st.checkpoint_failed = failed_reason
            st.phase = PHASE_DONE
        else:
            self._advance()
        st.advance_request = True

    def consume_advance(self) -> Tuple[str, Optional[Segment]]:
        """Process a pending advance (call only when advance_request is
        True). Returns the next action for the node to perform."""
        st = self._state
        if not st.advance_request:
            raise RuntimeError("consume_advance with no pending request")
        st.advance_request = False
        return self._next_action()

    # -- internals ----------------------------------------------------------

    def _begin_current(self):
        """Set the phase for the leg at ``idx`` (no advance signalling)."""
        st = self._state
        if st.idx >= len(st.plan.segments):
            st.phase = PHASE_DONE
        elif st.current.start_index == st.current.end_index:
            # Zero-length leg: the checkpoint runs where the robot is.
            st.phase = PHASE_CHECKPOINT
        else:
            st.phase = PHASE_MOVING

    def _advance(self):
        """Move on to the next leg (or done), setting its phase."""
        st = self._state
        st.idx += 1
        st.attempt = 1
        self._begin_current()

    def _next_action(self) -> Tuple[str, Optional[Segment]]:
        st = self._state
        if st.phase == PHASE_DONE:
            return NEXT_DONE, None
        if st.phase == PHASE_CHECKPOINT:
            return NEXT_CHECKPOINT, st.current
        return NEXT_SEND, st.current


if __name__ == "__main__":
    # Tiny sanity walk (run directly: python3 segments.py).
    from .checkpoints import ActionSpec, CheckpointSpec, plan_segments
    plan = plan_segments(
        5, [CheckpointSpec(id="a", point_index=2, on_failure="fail",
                           attempts=2,
                           actions=(ActionSpec(type="dwell", value=1000),))])
    c = SegmentController(plan)
    step = c.initial()
    while True:
        print(step, "phase=%s idx=%d" % (c.state.phase, c.state.idx))
        action, seg = step
        if action == NEXT_DONE:
            break
        if action == NEXT_SEND:
            c.on_goal_sent()
            c.on_segment_result(True)
        else:
            c.checkpoint_finished()
        step = c.consume_advance()
