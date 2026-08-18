"""Checkpoint sidecar parsing, segment planning and CheckpointStore tests.

Pure Python, no ROS required.

Run: python3 -m unittest discover -s test -v
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(
    0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from omni_mission_manager.checkpoints import (  # noqa: E402
    ACTION_DWELL,
    ACTION_PHOTO,
    ACTION_RECORD,
    ACTION_RECOGNIZE,
    CheckpointStore,
    CheckpointsMalformed,
    checkpoint_progress,
    parse_checkpoint_sidecar,
    plan_segments,
    segment_progress,
    sidecar_path,
)
from omni_mission_manager.route_store import RouteStore  # noqa: E402

SAMPLE_ROUTE = """\
# omni_slam global body path v1
# frame_id: lio_map
# columns: x y z
0.0 0.0 0.0
1.0 0.0 0.0
2.0 0.0 0.0
3.0 0.0 0.0
4.0 0.0 0.0
"""

N_POINTS = 5


def doc(checkpoints, schema_version=1):
    raw = {"checkpoints": checkpoints}
    if schema_version is not None:
        raw["schema_version"] = schema_version
    return json.dumps(raw)


def parse(text, num_points=N_POINTS):
    return parse_checkpoint_sidecar(text, num_points)


class ParseValidTests(unittest.TestCase):
    def test_full_document(self):
        specs = parse(doc([
            {"id": "cp-01", "point_index": 1, "on_failure": "skip",
             "attempts": 3,
             "actions": [
                 {"type": "dwell", "ms": 2000},
                 {"type": "photo", "count": 3},
                 {"type": "record", "seconds": 10},
                 {"type": "recognize", "target": "meter-01"}]},
            {"id": "cp_02", "point_index": 3,
             "actions": [{"type": "photo", "count": 1}]},
        ]))
        self.assertEqual(len(specs), 2)

        a = specs[0]
        self.assertEqual(a.id, "cp-01")
        self.assertEqual(a.point_index, 1)
        self.assertEqual(a.on_failure, "skip")
        self.assertEqual(a.attempts, 3)
        self.assertEqual([(x.type, x.value, x.target) for x in a.actions],
                         [(ACTION_DWELL, 2000, ""),
                          (ACTION_PHOTO, 3, ""),
                          (ACTION_RECORD, 10, ""),
                          (ACTION_RECOGNIZE, 0, "meter-01")])

        b = specs[1]
        self.assertEqual(b.on_failure, "fail")  # default
        self.assertEqual(b.attempts, 2)         # default
        self.assertEqual(b.actions[0].type, ACTION_PHOTO)
        self.assertEqual(b.actions[0].value, 1)  # default count

    def test_defaults_for_each_action_type(self):
        specs = parse(doc([
            {"id": "c1", "point_index": 0,
             "actions": [
                 {"type": "dwell"},
                 {"type": "photo"},
                 {"type": "record"},
             ]},
        ]))
        a = specs[0].actions
        self.assertEqual((a[0].value), 1000)  # dwell ms default
        self.assertEqual((a[1].value), 1)     # photo count default
        self.assertEqual((a[2].value), 5)     # record seconds default

    def test_record_seconds_accepts_float(self):
        specs = parse(doc([
            {"id": "c1", "point_index": 0,
             "actions": [{"type": "record", "seconds": 2.5}]},
        ]))
        self.assertEqual(specs[0].actions[0].value, 2.5)


class ParseMalformedTests(unittest.TestCase):
    def _fail(self, checkpoints, **doc_kw):
        with self.assertRaises(CheckpointsMalformed):
            parse(doc(checkpoints, **doc_kw))

    def test_invalid_json(self):
        with self.assertRaises(CheckpointsMalformed):
            parse("corrupted")

    def test_top_level_not_object(self):
        with self.assertRaises(CheckpointsMalformed):
            parse("[1, 2, 3]")

    def test_schema_version_missing(self):
        self._fail([{"id": "c1", "point_index": 0,
                     "actions": [{"type": "dwell"}]}],
                   schema_version=None)

    def test_schema_version_wrong(self):
        self._fail([{"id": "c1", "point_index": 0,
                     "actions": [{"type": "dwell"}]}],
                   schema_version=2)

    def test_checkpoints_missing(self):
        with self.assertRaises(CheckpointsMalformed):
            parse("{}")

    def test_checkpoints_empty(self):
        self._fail([])

    def test_checkpoint_not_object(self):
        self._fail(["nope"])

    def test_id_missing(self):
        self._fail([{"point_index": 0, "actions": [{"type": "dwell"}]}])

    def test_id_bad_grammar(self):
        for bad in ("", "-lead", ".dot", "sp ace", "a" * 65, "ünïcode"):
            self._fail([{"id": bad, "point_index": 0,
                         "actions": [{"type": "dwell"}]}])

    def test_id_duplicated(self):
        self._fail([
            {"id": "c1", "point_index": 0, "actions": [{"type": "dwell"}]},
            {"id": "c1", "point_index": 1, "actions": [{"type": "dwell"}]},
        ])

    def test_point_index_out_of_range(self):
        for bad in (-1, N_POINTS):
            self._fail([{"id": "c1", "point_index": bad,
                         "actions": [{"type": "dwell"}]}])

    def test_point_index_not_integer(self):
        for bad in (1.5, "2", True, None):
            self._fail([{"id": "c1", "point_index": bad,
                         "actions": [{"type": "dwell"}]}])

    def test_on_failure_invalid(self):
        self._fail([{"id": "c1", "point_index": 0, "on_failure": "boom",
                     "actions": [{"type": "dwell"}]}])

    def test_attempts_out_of_range(self):
        for bad in (0, 4):
            self._fail([{"id": "c1", "point_index": 0, "attempts": bad,
                         "actions": [{"type": "dwell"}]}])

    def test_actions_empty(self):
        self._fail([{"id": "c1", "point_index": 0, "actions": []}])

    def test_actions_missing(self):
        self._fail([{"id": "c1", "point_index": 0}])

    def test_action_not_object(self):
        self._fail([{"id": "c1", "point_index": 0, "actions": ["dwell"]}])

    def test_action_type_unknown(self):
        self._fail([{"id": "c1", "point_index": 0,
                     "actions": [{"type": "vibrate"}]}])

    def test_dwell_ms_out_of_range(self):
        for bad in (99, 60001):
            self._fail([{"id": "c1", "point_index": 0,
                         "actions": [{"type": "dwell", "ms": bad}]}])

    def test_photo_count_out_of_range(self):
        for bad in (0, 21):
            self._fail([{"id": "c1", "point_index": 0,
                         "actions": [{"type": "photo", "count": bad}]}])

    def test_record_seconds_out_of_range(self):
        for bad in (0, 601):
            self._fail([{"id": "c1", "point_index": 0,
                         "actions": [{"type": "record", "seconds": bad}]}])

    def test_recognize_target_empty(self):
        self._fail([{"id": "c1", "point_index": 0,
                     "actions": [{"type": "recognize", "target": ""}]}])

    def test_recognize_target_too_long(self):
        self._fail([{"id": "c1", "point_index": 0,
                     "actions": [{"type": "recognize",
                                  "target": "x" * 129}]}])

    def test_recognize_target_non_string(self):
        self._fail([{"id": "c1", "point_index": 0,
                     "actions": [{"type": "recognize", "target": 7}]}])

    def test_dwell_ms_bool_rejected(self):
        # bool is an int subclass; True/False must not slip through.
        self._fail([{"id": "c1", "point_index": 0,
                     "actions": [{"type": "dwell", "ms": True}]}])


class PlanSegmentsTests(unittest.TestCase):
    def cp(self, cp_id, point_index):
        from omni_mission_manager.checkpoints import ActionSpec, \
            CheckpointSpec
        return CheckpointSpec(
            id=cp_id, point_index=point_index, on_failure="fail",
            attempts=2,
            actions=(ActionSpec(type=ACTION_DWELL, value=1000),))

    def legs(self, num_points, cps):
        plan = plan_segments(num_points, cps)
        return [(s.start_index, s.end_index, s.checkpoint_id)
                for s in plan.segments], plan

    def test_no_checkpoints_single_full_route_leg(self):
        legs, plan = self.legs(N_POINTS, [])
        self.assertEqual(legs, [(0, N_POINTS - 1, "")])
        self.assertEqual(plan.num_points, N_POINTS)
        self.assertEqual(plan.specs, {})

    def test_checkpoint_in_middle(self):
        legs, _ = self.legs(N_POINTS, [self.cp("a", 2)])
        self.assertEqual(legs, [(0, 2, "a"), (2, N_POINTS - 1, "")])

    def test_checkpoint_at_start_zero_length(self):
        legs, _ = self.legs(N_POINTS, [self.cp("a", 0)])
        self.assertEqual(legs, [(0, 0, "a"), (0, N_POINTS - 1, "")])

    def test_checkpoint_at_end_no_trailing_leg(self):
        legs, _ = self.legs(N_POINTS, [self.cp("a", N_POINTS - 1)])
        self.assertEqual(legs, [(0, N_POINTS - 1, "a")])

    def test_unordered_input_sorted(self):
        legs, _ = self.legs(
            N_POINTS, [self.cp("b", 3), self.cp("a", 1)])
        self.assertEqual(legs, [(0, 1, "a"), (1, 3, "b"),
                                (3, N_POINTS - 1, "")])

    def test_two_checkpoints_same_point(self):
        legs, _ = self.legs(
            N_POINTS, [self.cp("a", 2), self.cp("b", 2)])
        self.assertEqual(legs, [(0, 2, "a"), (2, 2, "b"),
                                (2, N_POINTS - 1, "")])

    def test_route_too_short_rejected(self):
        with self.assertRaises(CheckpointsMalformed):
            plan_segments(1, [])

    def test_specs_indexed_by_id(self):
        from omni_mission_manager.checkpoints import CheckpointSpec
        a = CheckpointSpec(id="a", point_index=1, on_failure="skip",
                           attempts=1, actions=())
        _legs, plan = self.legs(N_POINTS, [a])
        self.assertIn("a", plan.specs)
        self.assertEqual(plan.specs["a"].on_failure, "skip")


class ProgressTests(unittest.TestCase):
    def test_segment_progress_maps_to_overall(self):
        # 5 points, leg (0..2): local 0.5 -> (0 + 0.5*2)/4 = 0.25
        from omni_mission_manager.checkpoints import Segment
        seg = Segment(0, 2, "a")
        self.assertAlmostEqual(segment_progress(seg, 0.0, 5), 0.0)
        self.assertAlmostEqual(segment_progress(seg, 0.5, 5), 0.25)
        self.assertAlmostEqual(segment_progress(seg, 1.0, 5), 0.5)

    def test_segment_progress_clamps_out_of_range_feedback(self):
        from omni_mission_manager.checkpoints import Segment
        seg = Segment(2, 4, "")
        self.assertAlmostEqual(segment_progress(seg, -1, 5), 0.5)
        self.assertAlmostEqual(segment_progress(seg, 2.0, 5), 1.0)

    def test_checkpoint_progress_is_leg_end(self):
        from omni_mission_manager.checkpoints import Segment
        self.assertAlmostEqual(checkpoint_progress(Segment(0, 2, "a"), 5),
                               0.5)


class SidecarPathTests(unittest.TestCase):
    def test_txt_route(self):
        p = sidecar_path("/routes/r1.txt")
        self.assertEqual(str(p), "/routes/r1.checkpoints.json")

    def test_other_suffix_left_as_stem(self):
        p = sidecar_path("/routes/r1.weird")
        self.assertEqual(str(p), "/routes/r1.weird.checkpoints.json")


class CheckpointStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.routes_dir = os.path.join(self.tmp.name, "routes")
        os.makedirs(self.routes_dir)
        with open(os.path.join(self.routes_dir, "r1.txt"), "w") as f:
            f.write(SAMPLE_ROUTE)
        self.store = CheckpointStore(RouteStore(self.routes_dir))

    def test_no_sidecar_empty(self):
        self.assertEqual(self.store.load("r1"), ())

    def test_sidecar_loaded(self):
        with open(os.path.join(self.routes_dir, "r1.checkpoints.json"),
                  "w") as f:
            f.write(doc([{"id": "a", "point_index": 1,
                          "actions": [{"type": "dwell"}]}]))
        specs = self.store.load("r1")
        self.assertEqual(len(specs), 1)
        self.assertEqual(specs[0].id, "a")
        self.assertEqual(specs[0].point_index, 1)

    def test_malformed_sidecar_raises(self):
        with open(os.path.join(self.routes_dir, "r1.checkpoints.json"),
                  "w") as f:
            f.write("corrupted")
        with self.assertRaises(CheckpointsMalformed):
            self.store.load("r1")

    def test_point_index_validated_against_route(self):
        with open(os.path.join(self.routes_dir, "r1.checkpoints.json"),
                  "w") as f:
            f.write(doc([{"id": "a", "point_index": 99,
                          "actions": [{"type": "dwell"}]}]))
        with self.assertRaises(CheckpointsMalformed):
            self.store.load("r1")


if __name__ == "__main__":
    unittest.main()