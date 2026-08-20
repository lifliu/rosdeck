"""ReturnToDock pure-core tests — pure Python, no ROS required.

Run: python3 -m unittest discover -s test -v
"""

import math
import os
import sys
import unittest

sys.path.insert(
    0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from omni_mission_manager import constants as C  # noqa: E402
from omni_mission_manager.return_to_dock import (  # noqa: E402
    LowBatteryTrigger,
    RtdContext,
    ReturnToDock,
    ReturnToDockMachine,
    check_goal,
)


def make_ctx(**kw):
    """A healthy robot state; override fields per test."""
    d = dict(
        fresh=True,
        estop_latched=False,
        charging=False,
        map_id="map1",
        map_version="2",
        localization_state=C.LOC_LOCALIZED,
        pose_fresh=True,
        mission_active=False,
    )
    d.update(kw)
    return RtdContext(**d)


class TestCheckGoal(unittest.TestCase):

    def setUp(self):
        self.lookups = []

    def dock_lookup(self):
        self.lookups.append(1)
        return (1.5, 2.5)

    def reject(self, **ctx_kw):
        ctx = make_ctx(**ctx_kw)
        return check_goal("req-1", C.RTD_TRIGGER_USER, ctx,
                          busy=False, replayed=False,
                          dock_lookup=self.dock_lookup)

    def test_accept(self):
        ok, code, text, standoff = self.reject()
        self.assertTrue(ok)
        self.assertEqual(code, C.RTD_REASON_OK)
        self.assertEqual(text, "")
        self.assertEqual(standoff, (1.5, 2.5))
        self.assertEqual(self.lookups, [1])  # dock lookup called once

    def test_empty_request_id(self):
        ctx = make_ctx()
        ok, code, text, standoff = check_goal(
            "", C.RTD_TRIGGER_USER, ctx, False, False,
            self.dock_lookup)
        self.assertFalse(ok)
        self.assertEqual(code, C.RTD_REASON_REJECTED)
        self.assertEqual(standoff, None)
        self.assertEqual(self.lookups, [])  # no lookup on reject

    def test_busy(self):
        ok, code, text, standoff = check_goal(
            "req-1", C.RTD_TRIGGER_USER, make_ctx(),
            busy=True, replayed=False, dock_lookup=self.dock_lookup)
        self.assertFalse(ok)
        self.assertEqual(code, C.RTD_REASON_REJECTED)
        self.assertIn("in progress", text)
        self.assertEqual(self.lookups, [])

    def test_replayed(self):
        ok, code, text, standoff = check_goal(
            "req-1", C.RTD_TRIGGER_USER, make_ctx(),
            busy=False, replayed=True, dock_lookup=self.dock_lookup)
        self.assertFalse(ok)
        self.assertEqual(code, C.RTD_REASON_REJECTED)
        self.assertIn("already executed", text)
        self.assertEqual(self.lookups, [])

    def test_already_charging(self):
        ok, code, text, standoff = self.reject(charging=True)
        self.assertFalse(ok)
        self.assertEqual(code, C.RTD_REASON_REJECTED)
        self.assertIn("already charging", text)

    def test_estop_latched(self):
        ok, code, text, standoff = self.reject(estop_latched=True)
        self.assertFalse(ok)
        self.assertEqual(code, C.RTD_REASON_REJECTED)
        self.assertIn("estop", text)

    def test_no_map(self):
        ok, code, text, standoff = self.reject(map_id="")
        self.assertFalse(ok)
        self.assertEqual(code, C.RTD_REASON_REJECTED)
        self.assertIn("no current map", text)

    def test_stale_robot_state(self):
        ok, code, text, standoff = self.reject(fresh=False)
        self.assertFalse(ok)
        self.assertEqual(code, C.RTD_REASON_REJECTED)
        self.assertIn("not fresh", text)

    def test_no_pose(self):
        ok, code, text, standoff = self.reject(pose_fresh=False)
        self.assertFalse(ok)
        self.assertEqual(code, C.RTD_REASON_REJECTED)
        self.assertIn("no current pose", text)

    def test_localization_not_ready(self):
        ok, code, text, standoff = self.reject(
            localization_state=C.LOC_LOST)
        self.assertFalse(ok)
        self.assertEqual(code, C.RTD_REASON_LOCALIZATION_NOT_READY)
        self.assertIn("localization not ready", text)
        self.assertEqual(self.lookups, [])

    def test_mission_active_rejects_user_trigger(self):
        ok, code, text, standoff = self.reject(mission_active=True)
        self.assertFalse(ok)
        self.assertEqual(code, C.RTD_REASON_MISSION_ACTIVE)
        self.assertIn("mission is active", text)
        self.assertEqual(self.lookups, [])

    def test_mission_allows_low_battery_trigger(self):
        ctx = make_ctx(mission_active=True)
        ok, code, text, standoff = check_goal(
            "req-1", C.RTD_TRIGGER_LOW_BATTERY, ctx, False, False,
            self.dock_lookup)
        self.assertTrue(ok)
        self.assertEqual(code, C.RTD_REASON_OK)
        self.assertEqual(standoff, (1.5, 2.5))

    def test_dock_not_found(self):
        ok, code, text, standoff = check_goal(
            "req-1", C.RTD_TRIGGER_USER, make_ctx(), False, False,
            lambda: None)
        self.assertFalse(ok)
        self.assertEqual(code, C.RTD_REASON_DOCK_NOT_FOUND)
        self.assertIn("map1", text)


class TestReturnToDockChain(unittest.TestCase):

    def test_progress_over_chain(self):
        rtd = ReturnToDock("req-1", C.RTD_TRIGGER_USER)
        self.assertEqual(rtd.state, C.RTD_STATE_PREPARING)
        self.assertEqual(rtd.progress, 0.0)

        rtd.on_nav_feedback(0.5, "following route")
        self.assertEqual(rtd.state, C.RTD_STATE_NAVIGATING)
        self.assertAlmostEqual(rtd.progress, C.RTD_NAV_WEIGHT * 0.5)

        rtd.on_nav_result(True, C.PLANNER_REASON_OK, "")
        self.assertEqual(rtd.state, C.RTD_STATE_FINAL_APPROACH)
        self.assertEqual(rtd.progress, C.RTD_NAV_WEIGHT)

        rtd.on_dock_feedback(C.DOCK_STATE_ACQUIRING, 0.5, "approaching")
        self.assertEqual(rtd.state, C.RTD_STATE_FINAL_APPROACH)
        self.assertAlmostEqual(
            rtd.progress, C.RTD_NAV_WEIGHT + C.RTD_APPROACH_WEIGHT * 0.5)

        rtd.on_dock_feedback(C.DOCK_STATE_WAITING_CHARGE, 1.0,
                             "waiting for charge")
        self.assertEqual(rtd.state, C.RTD_STATE_WAITING_CHARGE)
        self.assertAlmostEqual(
            rtd.progress, C.RTD_NAV_WEIGHT + C.RTD_APPROACH_WEIGHT)

        rtd.on_dock_result(True, C.DOCK_REASON_OK, "", True)
        self.assertTrue(rtd.terminal)
        self.assertTrue(rtd.success)
        self.assertEqual(rtd.reason_code, C.RTD_REASON_OK)
        self.assertTrue(rtd.docked)
        self.assertTrue(rtd.charging)
        self.assertEqual(rtd.state, C.RTD_STATE_CHARGING)
        self.assertEqual(rtd.progress, 1.0)

    def test_nav_failure(self):
        rtd = ReturnToDock("req-1", C.RTD_TRIGGER_USER)
        rtd.on_nav_feedback(0.2, "x")
        rtd.on_nav_result(False, C.PLANNER_REASON_ABORTED, "estop")
        self.assertTrue(rtd.terminal)
        self.assertFalse(rtd.success)
        self.assertEqual(rtd.reason_code, C.RTD_REASON_NAVIGATION_FAILED)
        self.assertIn("estop", rtd.reason_text)
        self.assertFalse(rtd.docked)
        self.assertFalse(rtd.charging)
        self.assertEqual(rtd.progress, 0.12)  # frozen at nav progress

    def test_dock_control_denied_passes_through(self):
        rtd = ReturnToDock("req-1", C.RTD_TRIGGER_USER)
        rtd.on_dock_result(False, C.DOCK_REASON_CONTROL_DENIED,
                           "app has control", False)
        self.assertTrue(rtd.terminal)
        self.assertFalse(rtd.success)
        self.assertEqual(rtd.reason_code, C.RTD_REASON_CONTROL_DENIED)
        self.assertEqual(rtd.reason_text, "app has control")

    def test_dock_other_failure_maps_to_dock_failed(self):
        rtd = ReturnToDock("req-1", C.RTD_TRIGGER_USER)
        rtd.on_dock_result(False, C.DOCK_REASON_APPROACH_TIMEOUT,
                           "timed out", False)
        self.assertEqual(rtd.reason_code, C.RTD_REASON_DOCK_FAILED)
        self.assertIn("timed out", rtd.reason_text)

    def test_dock_ok_but_charge_not_confirmed(self):
        rtd = ReturnToDock("req-1", C.RTD_TRIGGER_USER)
        rtd.on_dock_result(True, C.DOCK_REASON_OK, "", False)
        self.assertTrue(rtd.terminal)
        self.assertFalse(rtd.success)
        self.assertEqual(rtd.reason_code, C.RTD_REASON_DOCK_FAILED)
        self.assertIn("charge was not confirmed", rtd.reason_text)
        self.assertTrue(rtd.docked)
        self.assertFalse(rtd.charging)

    def test_late_feedback_ignored_after_terminal(self):
        rtd = ReturnToDock("req-1", C.RTD_TRIGGER_USER)
        rtd.on_lease_lost("lease lost")
        self.assertTrue(rtd.terminal)
        rtd.on_nav_feedback(0.9, "x")
        rtd.on_dock_result(True, C.DOCK_REASON_OK, "", True)
        self.assertFalse(rtd.success)
        self.assertEqual(rtd.reason_code, C.RTD_REASON_ABORTED)

    def test_cancel(self):
        rtd = ReturnToDock("req-1", C.RTD_TRIGGER_USER)
        rtd.on_nav_feedback(0.5, "x")
        ok, code, text = rtd.cancel()
        self.assertTrue(ok)
        self.assertEqual(code, C.RTD_REASON_USER_CANCELED)
        self.assertTrue(rtd.terminal)
        self.assertFalse(rtd.success)
        # Second cancel: already terminal.
        ok2, code2, text2 = rtd.cancel()
        self.assertFalse(ok2)
        self.assertEqual(code2, C.RTD_REASON_USER_CANCELED)
        self.assertEqual(text2, text)

    def test_lease_lost(self):
        rtd = ReturnToDock("req-1", C.RTD_TRIGGER_USER)
        rtd.on_lease_lost("active owner=1 app")
        self.assertTrue(rtd.terminal)
        self.assertEqual(rtd.reason_code, C.RTD_REASON_ABORTED)
        self.assertIn("active owner=1", rtd.reason_text)


class TestReturnToDockMachine(unittest.TestCase):

    def test_begin_active_was_executed(self):
        m = ReturnToDockMachine()
        self.assertIsNone(m.active())
        self.assertFalse(m.was_executed("a"))
        rtd = m.begin("a", C.RTD_TRIGGER_USER)
        self.assertIs(m.active(), rtd)
        self.assertTrue(m.was_executed("a"))
        self.assertFalse(m.was_executed("b"))

    def test_clear_only_matching(self):
        m = ReturnToDockMachine()
        rtd = m.begin("a", C.RTD_TRIGGER_USER)
        m.clear("b")  # no-op
        self.assertIs(m.active(), rtd)
        m.clear("a")
        self.assertIsNone(m.active())
        # Still remembered as executed (idempotency survives clear).
        self.assertTrue(m.was_executed("a"))

    def test_shutdown_aborts_active_chain(self):
        m = ReturnToDockMachine()
        rtd = m.begin("a", C.RTD_TRIGGER_USER)
        got = m.shutdown()
        self.assertIs(got, rtd)
        self.assertTrue(rtd.terminal)
        self.assertEqual(rtd.reason_code, C.RTD_REASON_ABORTED)
        self.assertIn("shutting down", rtd.reason_text)
        # Chain stays in place for the goal callback.
        self.assertIs(m.active(), rtd)

    def test_shutdown_without_chain(self):
        m = ReturnToDockMachine()
        self.assertIsNone(m.shutdown())


class TestLowBatteryTrigger(unittest.TestCase):

    def test_fires_at_and_below_threshold(self):
        t = LowBatteryTrigger(20.0, 5.0)
        self.assertFalse(t.evaluate(21.0, False))
        self.assertTrue(t.evaluate(20.0, False))
        self.assertTrue(t.evaluate(10.0, False))
        self.assertFalse(t.fired)  # evaluate does not mark

    def test_no_refire_after_mark(self):
        t = LowBatteryTrigger(20.0, 5.0)
        self.assertTrue(t.evaluate(15.0, False))
        t.mark_fired()
        self.assertTrue(t.fired)
        self.assertFalse(t.evaluate(14.0, False))
        self.assertFalse(t.evaluate(5.0, False))

    def test_rearm_on_charging(self):
        t = LowBatteryTrigger(20.0, 5.0)
        t.mark_fired()
        # Charging re-arms WITHOUT firing (the robot is on the dock).
        self.assertFalse(t.evaluate(15.0, True))
        self.assertFalse(t.fired)
        # ...and the next low reading while still charging does not fire.
        self.assertFalse(t.evaluate(10.0, True))
        # Off the dock again (e.g. undocked, battery dropped): fires.
        self.assertTrue(t.evaluate(15.0, False))

    def test_rearm_on_recovered_battery(self):
        t = LowBatteryTrigger(20.0, 5.0)
        t.mark_fired()
        self.assertFalse(t.evaluate(24.9, False))
        self.assertTrue(t.fired)  # hysteresis not crossed yet
        self.assertFalse(t.evaluate(25.0, False))
        self.assertFalse(t.fired)  # re-armed
        self.assertTrue(t.evaluate(15.0, False))  # can fire again

    def test_hysteresis_boundary(self):
        t = LowBatteryTrigger(20.0, 5.0)
        t.mark_fired()
        self.assertFalse(t.evaluate(25.0, False))
        self.assertFalse(t.fired)

    def test_nan_never_fires(self):
        t = LowBatteryTrigger(20.0, 5.0)
        self.assertFalse(t.evaluate(float("nan"), False))
        self.assertFalse(t.fired)

    def test_disabled_at_zero_and_negative(self):
        for pct in (0.0, -1.0):
            t = LowBatteryTrigger(pct, 5.0)
            self.assertFalse(t.evaluate(1.0, False))
            self.assertFalse(t.fired)

    def test_threshold_float(self):
        t = LowBatteryTrigger(20)
        self.assertTrue(t.evaluate(19.5, False))


class TestStandoffGeometry(unittest.TestCase):
    """The dock-lookup standoff computation lives in the node (needs the
    srv client); the geometry itself is pinned here so a unit drift in
    the trig would show up in both places. Mirrors
    MissionManagerNode._rtd_dock_pose."""

    def _standoff(self, px, py, yaw, d):
        return (px - math.cos(yaw) * d, py - math.sin(yaw) * d)

    def test_facing_east_standoff_is_behind(self):
        # Dock at (10, 0) facing east (yaw=0): the robot approaches from
        # behind, i.e. from the west.
        x, y = self._standoff(10.0, 0.0, 0.0, 1.5)
        self.assertAlmostEqual(x, 8.5)
        self.assertAlmostEqual(y, 0.0)

    def test_facing_north(self):
        x, y = self._standoff(0.0, 10.0, math.pi / 2.0, 2.0)
        self.assertAlmostEqual(x, 0.0)
        self.assertAlmostEqual(y, 8.0)

    def test_facing_southeast(self):
        x, y = self._standoff(5.0, 5.0, -math.pi / 4.0, 1.0)
        self.assertAlmostEqual(x, 5.0 - math.cos(-math.pi / 4.0))
        self.assertAlmostEqual(y, 5.0 - math.sin(-math.pi / 4.0))


if __name__ == "__main__":
    unittest.main()
