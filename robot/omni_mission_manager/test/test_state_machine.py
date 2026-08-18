"""MissionMachine tests — pure Python, no ROS required.

Run: python3 -m unittest discover -s test -v
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(
    0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from omni_mission_manager import constants as C  # noqa: E402
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
"""

NOW = "2026-08-17T10:00:00Z"


def make_machine(db_path, now=NOW):
    routes = os.path.join(os.path.dirname(str(db_path)), "routes")
    if not os.path.isdir(routes):
        os.makedirs(routes)
    r1 = os.path.join(routes, "r1.txt")
    if not os.path.exists(r1):
        with open(r1, "w", encoding="utf-8") as f:
            f.write(SAMPLE_ROUTE)
    store = EventStore(db_path)
    machine = MissionMachine(store, RouteStore(routes), now_fn=lambda: now)
    return machine, store


def goal(**kw):
    base = dict(
        mission_id="", request_id="req1", sequence=1, map_id="",
        map_version="", route_id="r1", checkpoint_ids=())
    base.update(kw)
    return DispatchGoal(**base)


def robot(**kw):
    base = dict(
        fresh=True, localization_state=C.LOC_LOCALIZED,
        map_id="mapA", map_version="v1")
    base.update(kw)
    return RobotStateView(**base)


class DispatchGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = os.path.join(self.tmp.name, "mm.db")
        self.machine, self.store = make_machine(self.db)

    def test_accept_and_generate_id(self):
        out = self.machine.dispatch(goal(), robot())
        self.assertEqual(out.action, "accept")
        m = out.mission
        self.assertTrue(m.mission_id.startswith("m"))
        self.assertTrue(m.mission_id.endswith("-1"))
        self.assertEqual(m.state, C.MISSION_PENDING)
        self.assertEqual(self.store.lookup_mission_id("req1", 1),
                         m.mission_id)
        self.assertEqual(self.store.event_count(m.mission_id), 0)

    def test_confirm_dispatch_records_event(self):
        out = self.machine.dispatch(goal(), robot())
        m = self.machine.confirm_dispatch(out.mission.mission_id)
        self.assertEqual(m.event_seq, 1)
        ev = self.store._conn.execute(
            "SELECT * FROM mission_events").fetchone()
        self.assertEqual(ev["event"], C.EVENT_DISPATCHED)

    def test_checkpoints_rejected(self):
        # No sidecar on r1: any named checkpoint is unknown.
        out = self.machine.dispatch(goal(checkpoint_ids=("c1",)), robot())
        self.assertEqual(out.action, "reject")
        self.assertEqual(out.reason_code, C.REASON_REJECTED)
        self.assertIn("unknown checkpoint id(s): c1", out.reason_text)

    def test_missing_request_id_rejected(self):
        out = self.machine.dispatch(goal(request_id=""), robot())
        self.assertEqual(out.reason_code, C.REASON_REJECTED)

    def test_route_not_found(self):
        out = self.machine.dispatch(goal(route_id="nope"), robot())
        self.assertEqual(out.reason_code, C.REASON_ROUTE_NOT_FOUND)

    def test_stale_robot_rejected(self):
        out = self.machine.dispatch(goal(), robot(fresh=False))
        self.assertEqual(out.reason_code, C.REASON_LOCALIZATION_NOT_READY)

    def test_localization_lost_rejected(self):
        out = self.machine.dispatch(
            goal(), robot(localization_state=C.LOC_LOST))
        self.assertEqual(out.reason_code, C.REASON_LOCALIZATION_NOT_READY)

    def test_map_mismatch_robot_vs_goal(self):
        out = self.machine.dispatch(goal(map_id="mapB"), robot())
        self.assertEqual(out.reason_code, C.REASON_MAP_MISMATCH)

    def test_map_version_mismatch(self):
        out = self.machine.dispatch(goal(map_version="v2"), robot())
        self.assertEqual(out.reason_code, C.REASON_MAP_MISMATCH)

    def test_unbound_goal_ok(self):
        # V1: empty goal map + robot on any map is fine.
        out = self.machine.dispatch(goal(), robot())
        self.assertEqual(out.action, "accept")

    def _bind(self, map_id, map_version=""):
        self.machine._routes.bind("r1", map_id, map_version)

    def test_bound_route_inherited_into_mission(self):
        self._bind("mapA")
        out = self.machine.dispatch(goal(), robot())
        self.assertEqual(out.action, "accept")
        m = out.mission
        self.assertEqual(m.map_id, "mapA")  # from the route sidecar
        self.assertEqual(m.map_version, "")  # current version

    def test_bound_route_version_inherited(self):
        self._bind("mapA", "v1")
        ok = self.machine.dispatch(goal(), robot(map_version="v1"))
        self.assertEqual(ok.action, "accept")
        self.assertEqual(ok.mission.map_version, "v1")
        out = self.machine.dispatch(goal(request_id="req2"),
                                    robot(map_version="v2"))
        self.assertEqual(out.action, "reject")
        self.assertEqual(out.reason_code, C.REASON_MAP_MISMATCH)
        self.assertIn("version", out.reason_text)

    def test_goal_overrides_bound_route_version(self):
        self._bind("mapA", "v1")
        out = self.machine.dispatch(goal(map_version="v2"),
                                    robot(map_version="v2"))
        self.assertEqual(out.action, "accept")
        self.assertEqual(out.mission.map_version, "v2")

    def test_goal_map_conflicts_with_bound_route(self):
        self._bind("mapA")
        out = self.machine.dispatch(goal(map_id="mapB"), robot())
        self.assertEqual(out.action, "reject")
        self.assertEqual(out.reason_code, C.REASON_MAP_MISMATCH)
        self.assertIn("bound to map mapA", out.reason_text)

    def test_malformed_sidecar_rejected_at_dispatch(self):
        routes_dir = os.path.join(self.tmp.name, "routes")
        with open(os.path.join(routes_dir, "r2.txt"), "w") as f:
            f.write(SAMPLE_ROUTE)
        with open(os.path.join(routes_dir, "r2.route.json"), "w") as f:
            f.write("corrupted")
        out = self.machine.dispatch(goal(route_id="r2"), robot())
        self.assertEqual(out.action, "reject")
        self.assertEqual(out.reason_code, C.REASON_ROUTE_NOT_FOUND)
        self.assertIn("unreadable", out.reason_text)


class IdempotencyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = os.path.join(self.tmp.name, "mm.db")
        self.machine, self.store = make_machine(self.db)

    def test_duplicate_returns_original(self):
        first = self.machine.dispatch(goal(), robot())
        second = self.machine.dispatch(goal(), robot())
        self.assertEqual(second.action, "duplicate")
        self.assertIs(second.mission, first.mission)
        ok, code, _text, _p = self.machine.terminal_result(second.mission)
        self.assertFalse(ok)
        self.assertEqual(code, C.REASON_DUPLICATE)

    def test_stale_sequence_rejected(self):
        self.machine.dispatch(goal(sequence=2), robot())
        out = self.machine.dispatch(goal(sequence=1), robot())
        self.assertEqual(out.action, "reject")
        self.assertEqual(out.reason_code, C.REASON_REJECTED)
        self.assertIn("stale sequence", out.reason_text)

    def test_supersede_cancels_old(self):
        old = self.machine.dispatch(goal(sequence=1), robot())
        new = self.machine.dispatch(goal(sequence=2), robot())
        self.assertEqual(new.action, "accept")
        self.assertIs(new.superseded, old.mission)
        old_m = self.machine.get(old.mission.mission_id)
        self.assertEqual(old_m.state, C.MISSION_CANCELED)
        self.assertEqual(old_m.reason_code, C.REASON_USER_CANCELED)
        self.assertIn("superseded by sequence 2", old_m.reason_text)
        # Old key still resolves to the old (canceled) mission.
        dup = self.machine.dispatch(goal(sequence=1), robot())
        self.assertEqual(dup.action, "duplicate")
        self.assertIs(dup.mission, old_m)
        ok, code, _t, _p = self.machine.terminal_result(dup.mission)
        self.assertFalse(ok)
        self.assertEqual(code, C.REASON_USER_CANCELED)

    def test_other_request_rejected_while_active(self):
        self.machine.dispatch(goal(), robot())
        out = self.machine.dispatch(goal(request_id="req2"), robot())
        self.assertEqual(out.action, "reject")
        self.assertEqual(out.reason_code, C.REASON_REJECTED)
        self.assertIn("another mission is active", out.reason_text)

    def test_explicit_mission_id_collision(self):
        self.machine.dispatch(goal(mission_id="mX"), robot())
        out = self.machine.dispatch(goal(mission_id="mX",
                                        request_id="req2"), robot())
        # req2 cannot even get created: req1's mission is active.
        self.assertEqual(out.action, "reject")
        # Cancel first, then the explicit id is rejected as taken.
        self.machine.cancel("mX")
        out = self.machine.dispatch(goal(mission_id="mX",
                                         request_id="req2"), robot())
        self.assertEqual(out.action, "reject")
        self.assertEqual(out.reason_code, C.REASON_REJECTED)
        self.assertIn("already exists", out.reason_text)

    def test_abort_created_frees_key(self):
        out = self.machine.dispatch(goal(), robot())
        mid = out.mission.mission_id
        self.machine.abort_created(mid, C.REASON_CONTROL_DENIED, "denied")
        self.assertIsNone(self.machine.get(mid))
        self.assertIsNone(self.store.lookup_mission_id("req1", 1))
        retry = self.machine.dispatch(goal(), robot())
        self.assertEqual(retry.action, "accept")


class PlannerResultTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = os.path.join(self.tmp.name, "mm.db")
        self.machine, _ = make_machine(self.db)
        self.m = self.machine.dispatch(goal(), robot()).mission
        self.machine.confirm_dispatch(self.m.mission_id)

    def test_success(self):
        m = self.machine.on_planner_result(
            self.m.mission_id, True, C.PLANNER_REASON_OK, "", 1.0)
        self.assertEqual(m.state, C.MISSION_SUCCEEDED)
        ok, code, _t, p = self.machine.terminal_result(m)
        self.assertTrue(ok)
        self.assertEqual(code, C.REASON_OK)
        self.assertEqual(p, 1.0)

    def test_failure(self):
        m = self.machine.on_planner_result(
            self.m.mission_id, False, C.PLANNER_REASON_ABORTED, "boom", 0.3)
        self.assertEqual(m.state, C.MISSION_FAILED)
        ok, code, text, p = self.machine.terminal_result(m)
        self.assertFalse(ok)
        self.assertEqual(code, C.REASON_MISSION_FAILED)
        self.assertIn("boom", text)
        self.assertAlmostEqual(p, 0.3)

    def test_planner_cancel_after_manager_cancel_is_ignored(self):
        self.machine.cancel(self.m.mission_id)
        result = self.machine.on_planner_result(
            self.m.mission_id, False, C.PLANNER_REASON_USER_CANCELED, "", 0.1)
        self.assertIsNone(result)
        m = self.machine.get(self.m.mission_id)
        self.assertEqual(m.state, C.MISSION_CANCELED)
        self.assertEqual(m.progress, 0.0)  # untouched

    def test_feedback_starts_and_tracks_progress(self):
        self.machine.on_planner_feedback(
            self.m.mission_id, C.PLANNER_STATE_PLANNING, 0.0, "planning")
        m = self.machine.get(self.m.mission_id)
        self.assertEqual(m.state, C.MISSION_PENDING)
        self.machine.on_planner_feedback(
            self.m.mission_id, C.PLANNER_STATE_EXECUTING, 0.2, "go")
        m = self.machine.get(self.m.mission_id)
        self.assertEqual(m.state, C.MISSION_EXECUTING)
        self.assertAlmostEqual(m.progress, 0.2)
        self.assertEqual(m.event_seq, 2)  # DISPATCHED + STARTED

    def test_progress_clamped(self):
        self.machine.on_planner_feedback(
            self.m.mission_id, C.PLANNER_STATE_EXECUTING, 1.7, "")
        m = self.machine.get(self.m.mission_id)
        self.assertAlmostEqual(m.progress, 1.0)
        self.machine.on_planner_feedback(
            self.m.mission_id, C.PLANNER_STATE_EXECUTING, -0.5, "")
        m = self.machine.get(self.m.mission_id)
        self.assertAlmostEqual(m.progress, 0.0)

    def test_planner_rejected(self):
        m = self.machine.on_planner_rejected(
            self.m.mission_id, "already active")
        self.assertEqual(m.state, C.MISSION_FAILED)
        self.assertIn("already active", m.reason_text)

    def test_planner_lost(self):
        m = self.machine.on_planner_lost(self.m.mission_id)
        self.assertEqual(m.state, C.MISSION_FAILED)
        self.assertEqual(m.reason_code, C.REASON_MISSION_FAILED)


class ControlCommandTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = os.path.join(self.tmp.name, "mm.db")
        self.machine, _ = make_machine(self.db)

    def test_cancel_active(self):
        m = self.machine.dispatch(goal(), robot()).mission
        self.machine.confirm_dispatch(m.mission_id)
        ok, code, _ = self.machine.cancel("")
        self.assertTrue(ok)
        self.assertEqual(code, C.REASON_OK)
        m = self.machine.get(m.mission_id)
        self.assertEqual(m.state, C.MISSION_CANCELED)
        self.assertEqual(m.reason_code, C.REASON_USER_CANCELED)
        ok2, code2, _ = self.machine.cancel("")
        self.assertFalse(ok2)
        self.assertEqual(code2, C.REASON_REJECTED)

    def test_pause_resume_flow(self):
        m = self.machine.dispatch(goal(), robot()).mission
        self.machine.confirm_dispatch(m.mission_id)
        ok, code, _ = self.machine.pause("")
        self.assertTrue(ok)
        self.assertEqual(self.machine.get(m.mission_id).state,
                         C.MISSION_PAUSED)
        ok2, _c2, t2 = self.machine.pause("")
        self.assertFalse(ok2)
        self.assertIn("not pausable", t2)
        ok3, _c3, _ = self.machine.begin_resume("")
        self.assertTrue(ok3)
        m = self.machine.finish_resume(m.mission_id)
        self.assertEqual(m.state, C.MISSION_EXECUTING)
        self.assertEqual(m.event_seq, 3)  # DISPATCHED, PAUSED, RESUMED

    def test_resume_rejected_when_not_paused(self):
        m = self.machine.dispatch(goal(), robot()).mission
        ok, code, _ = self.machine.begin_resume(m.mission_id)
        self.assertFalse(ok)
        self.assertEqual(code, C.REASON_REJECTED)

    def test_cancel_unknown_id(self):
        ok, code, _ = self.machine.cancel("ghost")
        self.assertFalse(ok)
        self.assertEqual(code, C.REASON_REJECTED)


class RecoveryTests(unittest.TestCase):
    def test_restart_interrupts_active(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db = os.path.join(tmp.name, "mm.db")
        machine, store = make_machine(db)
        m = machine.dispatch(goal(), robot()).mission
        machine.confirm_dispatch(m.mission_id)
        store.close()

        machine2, _ = make_machine(db)
        out = machine2.recover_on_startup()
        self.assertEqual([x.mission_id for x in out], [m.mission_id])
        m2 = machine2.get(m.mission_id)
        self.assertEqual(m2.state, C.MISSION_INTERRUPTED)
        self.assertEqual(m2.reason_code, C.REASON_MISSION_INTERRUPTED)
        ok, code, _t, _p = machine2.terminal_result(m2)
        self.assertFalse(ok)
        self.assertEqual(code, C.REASON_MISSION_INTERRUPTED)
        # A second startup is a no-op.
        out2 = machine2.recover_on_startup()
        self.assertEqual(out2, [])

    def test_graceful_shutdown_interrupts(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db = os.path.join(tmp.name, "mm.db")
        machine, _ = make_machine(db)
        m = machine.dispatch(goal(), robot()).mission
        machine.confirm_dispatch(m.mission_id)
        out = machine.shutdown()
        self.assertEqual([x.mission_id for x in out], [m.mission_id])
        self.assertEqual(machine.get(m.mission_id).state,
                         C.MISSION_INTERRUPTED)

    def test_authority_lost_interrupts_executing(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db = os.path.join(tmp.name, "mm.db")
        machine, _ = make_machine(db)
        m = machine.dispatch(goal(), robot()).mission
        machine.confirm_dispatch(m.mission_id)
        machine.on_planner_feedback(
            m.mission_id, C.PLANNER_STATE_EXECUTING, 0.1, "")
        lost = machine.on_authority_lost("preempted by APP")
        self.assertEqual(lost.mission_id, m.mission_id)
        self.assertEqual(machine.get(m.mission_id).state,
                         C.MISSION_INTERRUPTED)

    def test_authority_lost_ignores_paused(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db = os.path.join(tmp.name, "mm.db")
        machine, _ = make_machine(db)
        m = machine.dispatch(goal(), robot()).mission
        machine.pause(m.mission_id)
        self.assertIsNone(machine.on_authority_lost("preempted"))
        self.assertEqual(machine.get(m.mission_id).state, C.MISSION_PAUSED)


class SnapshotTests(unittest.TestCase):
    def test_snapshot_none(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        machine, _ = make_machine(os.path.join(tmp.name, "mm.db"))
        snap = machine.snapshot()
        self.assertEqual(snap.state, C.MISSION_NONE)
        self.assertEqual(snap.mission_id, "")

    def test_snapshot_active(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        machine, _ = make_machine(os.path.join(tmp.name, "mm.db"))
        m = machine.dispatch(goal(), robot()).mission
        snap = machine.snapshot()
        self.assertIs(snap, m)


if __name__ == "__main__":
    unittest.main()