"""Checkpoint framework integration tests — machine + store + plan.

Covers the Phase 3 seams that the pure-module tests don't: dispatch with a
checkpoint sidecar (all / subset / unknown / malformed), the checkpoint
lifecycle on the mission machine, and the durable checkpoint_results
store. Pure Python, no ROS required.

Run: python3 -m unittest discover -s test -v
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(
    0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from omni_mission_manager import constants as C  # noqa: E402
from omni_mission_manager.checkpoints import CheckpointStore  # noqa: E402
from omni_mission_manager.event_store import EventStore  # noqa: E402
from omni_mission_manager.route_store import RouteStore  # noqa: E402
from omni_mission_manager.state_machine import (  # noqa: E402
    DispatchGoal,
    MissionMachine,
    RobotStateView,
)

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
NOW = "2026-08-17T10:00:00Z"


def sidecar(checkpoints, schema_version=1):
    raw = {"checkpoints": checkpoints}
    if schema_version is not None:
        raw["schema_version"] = schema_version
    return json.dumps(raw)


def goal(**kw):
    base = dict(
        mission_id="", request_id="req1", sequence=1, map_id="",
        map_version="", route_id="r1", checkpoint_ids=())
    base.update(kw)
    return DispatchGoal(**base)


def robot():
    return RobotStateView(
        fresh=True, localization_state=C.LOC_LOCALIZED,
        map_id="mapA", map_version="v1")


def cp_doc(cid, point_index, **kw):
    entry = {"id": cid, "point_index": point_index,
             "actions": [{"type": "dwell", "ms": 1000}]}
    entry.update(kw)
    return entry


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.routes = os.path.join(self.tmp.name, "routes")
        os.makedirs(self.routes)
        with open(os.path.join(self.routes, "r1.txt"), "w") as f:
            f.write(SAMPLE_ROUTE)
        self.store = EventStore(os.path.join(self.tmp.name, "mm.db"))
        self.addCleanup(self.store.close)
        routes = RouteStore(self.routes)
        self.machine = MissionMachine(
            self.store, routes, now_fn=lambda: NOW,
            checkpoint_store=CheckpointStore(routes))

    def write_sidecar(self, text):
        with open(os.path.join(self.routes, "r1.checkpoints.json"), "w") \
                as f:
            f.write(text)

    def legs(self, mission_id):
        plan = self.machine.get_plan(mission_id)
        self.assertIsNotNone(plan)
        return [(s.start_index, s.end_index, s.checkpoint_id)
                for s in plan.segments]


class CheckpointDispatchTests(Base):
    def test_no_sidecar_single_full_leg(self):
        out = self.machine.dispatch(goal(), robot())
        self.assertEqual(out.action, "accept")
        self.assertEqual(self.legs(out.mission.mission_id),
                         [(0, N_POINTS - 1, "")])

    def test_sidecar_runs_all_checkpoints(self):
        self.write_sidecar(sidecar([cp_doc("a", 1), cp_doc("b", 3)]))
        out = self.machine.dispatch(goal(), robot())
        self.assertEqual(out.action, "accept")
        self.assertEqual(self.legs(out.mission.mission_id),
                         [(0, 1, "a"), (1, 3, "b"), (3, N_POINTS - 1, "")])

    def test_sidecar_subset_selection(self):
        self.write_sidecar(sidecar([cp_doc("a", 1), cp_doc("b", 3)]))
        out = self.machine.dispatch(goal(checkpoint_ids=("b",)), robot())
        self.assertEqual(out.action, "accept")
        self.assertEqual(self.legs(out.mission.mission_id),
                         [(0, 3, "b"), (3, N_POINTS - 1, "")])

    def test_unknown_checkpoint_id_rejected(self):
        self.write_sidecar(sidecar([cp_doc("a", 1)]))
        out = self.machine.dispatch(goal(checkpoint_ids=("zzz",)), robot())
        self.assertEqual(out.action, "reject")
        self.assertEqual(out.reason_code, C.REASON_REJECTED)
        self.assertIn("unknown checkpoint id(s): zzz", out.reason_text)

    def test_no_sidecar_nonempty_selection_rejected(self):
        out = self.machine.dispatch(goal(checkpoint_ids=("c1",)), robot())
        self.assertEqual(out.action, "reject")
        self.assertEqual(out.reason_code, C.REASON_REJECTED)
        self.assertIn("unknown checkpoint id(s): c1", out.reason_text)

    def test_malformed_checkpoint_sidecar_rejected(self):
        self.write_sidecar("corrupted")
        out = self.machine.dispatch(goal(), robot())
        self.assertEqual(out.action, "reject")
        self.assertEqual(out.reason_code, C.REASON_ROUTE_NOT_FOUND)
        self.assertIn("route checkpoints unreadable", out.reason_text)

    def test_plan_popped_on_terminal(self):
        out = self.machine.dispatch(goal(), robot())
        mid = out.mission.mission_id
        self.machine.confirm_dispatch(mid)
        self.machine.on_planner_result(
            mid, True, C.PLANNER_REASON_OK, "route completed", 1.0)
        self.assertIsNone(self.machine.get_plan(mid))


class CheckpointLifecycleTests(Base):
    def _dispatched(self):
        out = self.machine.dispatch(goal(), robot())
        self.assertEqual(out.action, "accept")
        mid = out.mission.mission_id
        self.machine.confirm_dispatch(mid)
        return mid

    def test_started_promotes_pending_to_executing(self):
        mid = self._dispatched()
        self.assertEqual(self.store.event_count(mid), 1)  # DISPATCHED
        m = self.machine.get(mid)
        self.assertEqual(m.state, C.MISSION_PENDING)
        self.machine.on_checkpoint_started(mid, "a")
        m = self.machine.get(mid)
        self.assertEqual(m.state, C.MISSION_EXECUTING)
        self.assertEqual(m.current_checkpoint_id, "a")
        self.assertEqual(self.store.event_count(mid), 2)  # + STARTED

    def test_finished_clears_current_id(self):
        mid = self._dispatched()
        self.machine.on_checkpoint_started(mid, "a")
        self.machine.on_checkpoint_finished(mid)
        self.assertEqual(self.machine.get(mid).current_checkpoint_id, "")

    def test_failed_terminates_mission(self):
        mid = self._dispatched()
        self.machine.on_checkpoint_started(mid, "a")
        reason = "checkpoint action photo failed: camera down"
        m = self.machine.on_checkpoint_failed(mid, "a", reason)
        self.assertEqual(m.state, C.MISSION_FAILED)
        self.assertEqual(m.reason_text, "checkpoint a failed: %s" % reason)
        self.assertIsNone(self.machine.get_plan(mid))

    def test_started_on_terminal_mission_is_noop(self):
        mid = self._dispatched()
        self.machine.on_planner_result(
            mid, True, C.PLANNER_REASON_OK, "route completed", 1.0)
        self.machine.on_checkpoint_started(mid, "a")  # must not raise
        m = self.machine.get(mid)
        self.assertEqual(m.state, C.MISSION_SUCCEEDED)
        self.assertEqual(m.current_checkpoint_id, "")


class CheckpointResultStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = EventStore(os.path.join(self.tmp.name, "mm.db"))
        self.addCleanup(self.store.close)

    def append(self, mid, **kw):
        base = dict(checkpoint_id="a", action_type="photo", status=0,
                    attempts=1, reason="", artifact_path="/tmp/p.jpg",
                    result_json="{}", pose=(1.0, 2.0, 3.0, 0.5),
                    map_id="mapA", map_version="v1",
                    software_version="0.3.0", now=NOW)
        base.update(kw)
        self.store.append_checkpoint_result(mid, **base)

    def test_round_trip_and_sequence(self):
        self.append("m1")
        self.append("m1", checkpoint_id="b", action_type="recognize",
                    status=2, attempts=0, reason="mission interrupted",
                    artifact_path="", result_json="", pose=None)
        rows = self.store.get_checkpoint_results("m1")
        self.assertEqual(len(rows), 2)
        self.assertEqual([r["sequence"] for r in rows], [1, 2])

        r1 = rows[0]
        self.assertEqual(r1["checkpoint_id"], "a")
        self.assertEqual(r1["action_type"], "photo")
        self.assertEqual(r1["status"], 0)
        self.assertEqual(r1["attempts"], 1)
        self.assertEqual(r1["artifact_path"], "/tmp/p.jpg")
        self.assertEqual(r1["pose_x"], 1.0)
        self.assertEqual(r1["pose_yaw"], 0.5)
        self.assertEqual(r1["map_id"], "mapA")
        self.assertEqual(r1["software_version"], "0.3.0")
        self.assertEqual(r1["created_at"], NOW)

        r2 = rows[1]
        self.assertEqual(r2["pose_x"], 0.0)  # None pose -> zeros
        self.assertEqual(r2["pose_z"], 0.0)

    def test_sequence_independent_per_mission(self):
        self.append("m1")
        self.append("m2")
        self.assertEqual(
            [r["sequence"] for r in self.store.get_checkpoint_results("m2")],
            [1])

    def test_unknown_mission_empty(self):
        self.assertEqual(self.store.get_checkpoint_results("mX"), [])


if __name__ == "__main__":
    unittest.main()
