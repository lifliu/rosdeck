"""SegmentController tests — the leg-by-leg walk of a checkpoint plan.

Pure Python, no ROS required.

Run: python3 -m unittest discover -s test -v
"""

import os
import sys
import unittest

sys.path.insert(
    0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from omni_mission_manager.checkpoints import (  # noqa: E402
    ActionSpec,
    CheckpointPlan,
    CheckpointSpec,
    plan_segments,
)
from omni_mission_manager.segments import (  # noqa: E402
    NEXT_CHECKPOINT,
    NEXT_DONE,
    NEXT_SEND,
    PHASE_CHECKPOINT,
    PHASE_DONE,
    PHASE_IDLE,
    PHASE_MOVING,
    SegmentController,
)


def cp(cp_id, point_index):
    return CheckpointSpec(
        id=cp_id, point_index=point_index, on_failure="fail", attempts=2,
        actions=(ActionSpec(type="dwell", value=1000),))


class ControllerTests(unittest.TestCase):
    def walk(self, num_points=5, cps=()):
        return SegmentController(plan_segments(num_points, list(cps)))

    def test_initial_moving_leg(self):
        c = self.walk(cps=[cp("a", 2)])
        action, seg = c.initial()
        self.assertEqual(action, NEXT_SEND)
        self.assertEqual(seg.checkpoint_id, "a")
        self.assertEqual(c.state.phase, PHASE_MOVING)
        # initial() returns the action to act on directly; it must NOT
        # signal the timer (double-fire guard).
        self.assertFalse(c.state.advance_request)

    def test_planner_goal_id_format(self):
        c = self.walk(cps=[cp("a", 2), cp("b", 4)])
        c.initial()
        self.assertEqual(c.planner_goal_id("m1"), "m1-s0-a1")
        c.on_segment_result(True)
        c.consume_advance()      # -> NEXT_CHECKPOINT (still leg 0)
        c.checkpoint_finished()
        c.consume_advance()      # -> NEXT_SEND (leg 1)
        self.assertEqual(c.planner_goal_id("m1"), "m1-s1-a1")

    def test_walk_two_legs_with_checkpoint(self):
        # legs: (0..2, a) then (2..4, "")
        c = self.walk(cps=[cp("a", 2)])
        action, seg = c.initial()
        self.assertEqual(action, NEXT_SEND)
        c.on_goal_sent()
        c.on_segment_result(True)
        self.assertTrue(c.state.advance_request)
        self.assertEqual(c.state.phase, PHASE_CHECKPOINT)

        # Arrived at the checkpoint's point: run it before the next leg.
        action, seg = c.consume_advance()
        self.assertEqual(action, NEXT_CHECKPOINT)
        self.assertEqual(seg.checkpoint_id, "a")
        self.assertFalse(c.state.advance_request)

        c.checkpoint_finished()
        self.assertTrue(c.state.advance_request)
        self.assertEqual(c.state.phase, PHASE_MOVING)
        action, seg = c.consume_advance()
        self.assertEqual(action, NEXT_SEND)
        self.assertEqual(seg.start_index, 2)
        self.assertEqual(seg.end_index, 4)
        self.assertEqual(seg.checkpoint_id, "")

        c.on_goal_sent()
        c.on_segment_result(True)
        action, seg = c.consume_advance()
        self.assertEqual(action, NEXT_DONE)
        self.assertIsNone(seg)
        self.assertEqual(c.state.phase, PHASE_DONE)
        self.assertFalse(c.state.advance_request)

    def test_no_checkpoint_advances_straight_to_next_leg(self):
        # legs: (0..2, "") ... a plan whose first leg has no checkpoint
        # can only happen for the final leg, so use two checkpoints with
        # the first leg plain: (0..2, a) drives to cp a at point 2.
        c = self.walk(cps=[cp("a", 2)])
        c.initial()
        c.on_goal_sent()
        c.on_segment_result(True)  # leg (0..2,a) has a checkpoint
        self.assertEqual(c.state.phase, PHASE_CHECKPOINT)
        c.consume_advance()
        c.checkpoint_finished()
        c.consume_advance()  # next leg (2..4,"") has no checkpoint
        c.on_goal_sent()
        c.on_segment_result(True)  # final leg: straight to done
        self.assertEqual(c.state.phase, PHASE_DONE)
        action, _seg = c.consume_advance()
        self.assertEqual(action, NEXT_DONE)

    def test_checkpoint_failure_parks_controller(self):
        c = self.walk(cps=[cp("a", 2)])
        c.initial()
        c.on_goal_sent()
        c.on_segment_result(True)
        c.consume_advance()
        self.assertEqual(c.state.phase, PHASE_CHECKPOINT)
        reason = "checkpoint action photo failed: camera down"
        c.checkpoint_finished(reason)
        self.assertEqual(c.state.checkpoint_failed, reason)
        action, seg = c.consume_advance()
        self.assertEqual(action, NEXT_DONE)
        self.assertIsNone(seg)
        self.assertEqual(c.state.phase, PHASE_DONE)

    def test_zero_length_first_leg_runs_checkpoint_in_place(self):
        c = self.walk(cps=[cp("a", 0)])
        action, seg = c.initial()
        self.assertEqual(action, NEXT_CHECKPOINT)
        self.assertEqual(seg.start_index, 0)
        self.assertEqual(seg.end_index, 0)
        self.assertEqual(seg.checkpoint_id, "a")
        self.assertEqual(c.state.phase, PHASE_CHECKPOINT)

        c.checkpoint_finished()
        action, seg = c.consume_advance()
        self.assertEqual(action, NEXT_SEND)
        self.assertEqual(seg.start_index, 0)
        self.assertEqual(seg.end_index, 4)
        self.assertEqual(seg.checkpoint_id, "")

    def test_all_checkpoints_at_end_single_leg(self):
        c = self.walk(cps=[cp("a", 4)])
        action, seg = c.initial()
        self.assertEqual(action, NEXT_SEND)
        self.assertEqual(seg.end_index, 4)
        c.on_goal_sent()
        c.on_segment_result(True)
        c.consume_advance()  # checkpoint a (no trailing leg)
        self.assertEqual(c.state.phase, PHASE_CHECKPOINT)
        c.checkpoint_finished()
        action, seg = c.consume_advance()
        self.assertEqual(action, NEXT_DONE)
        self.assertEqual(c.state.phase, PHASE_DONE)

    def test_two_checkpoints_same_point(self):
        # legs: (0..2,a) (2..2,b) (2..4,"")
        c = self.walk(cps=[cp("a", 2), cp("b", 2)])
        action, seg = c.initial()
        self.assertEqual(action, NEXT_SEND)
        c.on_goal_sent()
        c.on_segment_result(True)
        c.consume_advance()  # checkpoint a
        self.assertEqual(c.state.current.checkpoint_id, "a")
        c.checkpoint_finished()
        action, seg = c.consume_advance()
        self.assertEqual(action, NEXT_CHECKPOINT)  # b is in place
        self.assertEqual(seg.checkpoint_id, "b")
        c.checkpoint_finished()
        action, seg = c.consume_advance()
        self.assertEqual(action, NEXT_SEND)
        self.assertEqual(seg.checkpoint_id, "")
        c.on_goal_sent()
        c.on_segment_result(True)
        action, _seg = c.consume_advance()
        self.assertEqual(action, NEXT_DONE)


class ControllerErrorTests(unittest.TestCase):
    def test_consume_advance_without_request_raises(self):
        c = SegmentController(plan_segments(5, []))
        c.initial()  # acts directly; no advance request is left behind
        with self.assertRaises(RuntimeError):
            c.consume_advance()

    def test_on_goal_sent_outside_moving_raises(self):
        c = SegmentController(plan_segments(5, [cp("a", 0)]))
        c.initial()  # zero-length leg -> checkpoint phase
        with self.assertRaises(RuntimeError):
            c.on_goal_sent()

    def test_on_segment_result_outside_moving_raises(self):
        c = SegmentController(plan_segments(5, [cp("a", 0)]))
        c.initial()
        with self.assertRaises(RuntimeError):
            c.on_segment_result(True)

    def test_checkpoint_finished_outside_checkpoint_phase_raises(self):
        c = SegmentController(plan_segments(5, []))
        c.initial()  # moving
        with self.assertRaises(RuntimeError):
            c.checkpoint_finished()

    def test_empty_plan_rejected(self):
        with self.assertRaises(ValueError):
            SegmentController(CheckpointPlan(segments=(), specs={},
                                             num_points=5))


class ProgressTests(unittest.TestCase):
    def test_moving_progress_maps_leg_to_overall(self):
        # legs: (0..2,a) (2..4,"")
        c = SegmentController(plan_segments(5, [cp("a", 2)]))
        c.initial()
        self.assertAlmostEqual(c.progress(0.0), 0.0)
        self.assertAlmostEqual(c.progress(1.0), 0.5)

    def test_checkpoint_progress_holds_at_leg_end(self):
        c = SegmentController(plan_segments(5, [cp("a", 2)]))
        c.initial()
        c.on_segment_result(True)
        c.consume_advance()
        self.assertEqual(c.state.phase, PHASE_CHECKPOINT)
        self.assertAlmostEqual(c.progress(0.0), 0.5)

    def test_done_progress_is_one(self):
        c = SegmentController(plan_segments(5, []))
        c.initial()
        c.on_segment_result(True)
        c.consume_advance()
        self.assertEqual(c.state.phase, PHASE_DONE)
        self.assertEqual(c.progress(0.0), 1.0)

    def test_progress_monotonic_across_walk(self):
        c = SegmentController(plan_segments(5, [cp("a", 2)]))
        seen = []
        c.initial()
        for p in (0.0, 0.5, 1.0):
            seen.append(c.progress(p))
        c.on_segment_result(True)
        c.consume_advance()
        seen.append(c.progress(0.0))
        c.checkpoint_finished()
        c.consume_advance()
        for p in (0.0, 1.0):
            seen.append(c.progress(p))
        c.on_segment_result(True)
        c.consume_advance()
        seen.append(c.progress(0.0))
        for prev, cur in zip(seen, seen[1:]):
            self.assertLessEqual(prev, cur)


if __name__ == "__main__":
    unittest.main()