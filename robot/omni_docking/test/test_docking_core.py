"""docking_core lifecycle tests — fake gateway + fake plant, no ROS.

The harness plays the node's role: it feeds the core a DockSnapshot at
20 Hz from a point-robot plant and a fake lease gateway, and acts on
each OpEvent exactly like docking_node does (publish acquire /
heartbeat / release, integrate the twist, finalize on terminal).

Geometry: dock at the origin facing +x (facing the dock face); the
approach side is -x, the standoff park point is (-0.6, 0, 0).

Run: python3 -m unittest discover -s test -v
"""

import math
import os
import sys
import unittest

sys.path.insert(
    0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from omni_docking import authority, constants as C  # noqa: E402
from omni_docking.charge_monitor import (  # noqa: E402
    BatterySample, ChargeMonitor)
from omni_docking.docking_core import (  # noqa: E402
    DockingCore, DockSnapshot, OP_DOCK, OP_UNDOCK)
from omni_docking.dock_config import DockPose, DockConfig  # noqa: E402

DT = 0.05
DOCK = DockPose(0.0, 0.0, 0.0, 0.6)
STANDBY = (-0.6, 0.0, 0.0)


def _wrap(a):
    return (a + math.pi) % (2 * math.pi) - math.pi


class Plant:
    def __init__(self, pose):
        self.pose = list(pose)

    def step(self, linear, angular, dt=DT):
        x, y, yaw = self.pose
        yaw = _wrap(yaw + angular * dt)
        x += linear * math.cos(yaw) * dt
        y += linear * math.sin(yaw) * dt
        self.pose = [x, y, yaw]


class FakeGateway:
    """The lease side of /rosdeck/control_command|status."""

    def __init__(self, owner=""):
        self.owner = owner
        self.commands = []

    def status(self):
        return "acquired:{}".format(self.owner) if self.owner else \
            "error:none"

    def send(self, text):
        self.commands.append(text)
        action, client_id = text.split(":", 1)
        if action == "acquire" and self.owner in ("", client_id):
            self.owner = client_id
        elif action == "release" and self.owner == client_id:
            self.owner = ""


def make_store():
    class Store:
        def look_up(self, map_id, map_version=""):
            if map_id == "m1":
                return DockConfig("m1", "", "dock-a", DOCK)
            return None
    return Store()


def default_params(**over):
    p = {
        "approach_timeout_sec": 45.0,
        "move_timeout_sec": 45.0,
        "charge_window_sec": 30.0,
        "pose_start_timeout_sec": 5.0,
        "pose_stale_sec": 1.0,
        "state_stale_sec": 2.0,
        "standoff_speed": 0.15,
        "final_speed": 0.05,
        "pos_tolerance": 0.15,
        "yaw_tolerance": 0.25,
    }
    p.update(over)
    return p


_NO_POSE = object()  # sentinel: distinguishes "no pose" from "plant pose"


def make_snap(now, plant, gw, pose=_NO_POSE, robot_fresh=True,
              estop_latched=False, localization=C.LOC_LOCALIZED,
              map_id="m1", map_version=""):
    return DockSnapshot(now, robot_fresh, estop_latched, localization,
                        map_id, map_version,
                        plant.pose if pose is _NO_POSE else pose,
                        gw.status())


def charging_battery(now):
    return BatterySample(voltage=52.8, percentage=87.5, current=2.0,
                         power=105.0, stamp=now)


class Harness:
    """Drives one op to its terminal (or max_ticks) like the node."""

    def __init__(self, plant=None, owner="", params=None, battery=None,
                 mutate=None, max_ticks=3000):
        self.plant = Plant(plant if plant is not None else STANDBY)
        self.gw = FakeGateway(owner)
        self.charge = ChargeMonitor()
        self.core = DockingCore(make_store(), self.charge,
                                params or default_params())
        self.battery = battery      # (now) -> sample|None, fed each tick
        self._mutate = mutate       # (tick_index, now, harness)
        self.max_ticks = max_ticks
        self.estop = False          # tests flip this via mutate()

    def run(self, kind, request_id):
        cid = authority.make_client_id(request_id)
        ok, code, text = self.core.start(
            kind, request_id,
            make_snap(0.0, self.plant, self.gw))
        if not ok:
            return {"ok": False, "code": code, "text": text,
                    "terminal": None, "ticks": 0}
        now = 0.0
        terminal = None
        last_twist = None
        ticks = 0
        for i in range(self.max_ticks):
            ticks = i + 1
            if self.battery is not None:
                s = self.battery(now)
                if s is not None:
                    self.charge.update(s)
            if self._mutate is not None:
                self._mutate(i, now, self)
            ev = self.core.update(make_snap(
                now, self.plant, self.gw, estop_latched=self.estop))
            if ev.acquire:
                self.gw.send(authority.command("acquire", cid))
            if ev.heartbeat:
                self.gw.send(authority.command("heartbeat", cid))
            if ev.release:
                self.gw.send(authority.command("release", cid))
            if ev.twist is not None:
                last_twist = ev.twist
                self.plant.step(*ev.twist)
            if ev.terminal:
                terminal = ev.terminal
                break
            now += DT
        self.core.finish()
        return {"ok": True, "code": code, "text": text,
                "terminal": terminal, "ticks": ticks,
                "last_twist": last_twist}


class GateTest(unittest.TestCase):
    def test_busy_rejected(self):
        h = Harness()
        ok, _c, _t = h.core.start(
            OP_DOCK, "req-1", make_snap(0.0, h.plant, h.gw))
        self.assertTrue(ok)
        # a second start while the first op is still active
        ok, code, text = h.core.start(
            OP_DOCK, "req-2", make_snap(0.1, h.plant, h.gw))
        self.assertFalse(ok)
        self.assertEqual(code, C.REASON_REJECTED)
        self.assertIn("active", text)

    def test_robot_state_stale(self):
        h = Harness()
        ok, code, text = h.core.start(
            OP_DOCK, "req-1",
            make_snap(0.0, h.plant, h.gw, robot_fresh=False))
        self.assertFalse(ok)
        self.assertEqual(code, C.REASON_REJECTED)
        self.assertIn("stale", text)

    def test_estop_latched(self):
        h = Harness()
        ok, code, text = h.core.start(
            OP_DOCK, "req-1",
            make_snap(0.0, h.plant, h.gw, estop_latched=True))
        self.assertFalse(ok)
        self.assertEqual(code, C.REASON_REJECTED)
        self.assertIn("estop", text)

    def test_localization_not_ready(self):
        h = Harness()
        ok, code, text = h.core.start(
            OP_DOCK, "req-1",
            make_snap(0.0, h.plant, h.gw, localization=C.LOC_LOST))
        self.assertFalse(ok)
        self.assertEqual(code, C.REASON_LOCALIZATION_LOST)

    def test_no_dock_for_map(self):
        h = Harness()
        ok, code, text = h.core.start(
            OP_DOCK, "req-1",
            make_snap(0.0, h.plant, h.gw, map_id="nowhere"))
        self.assertFalse(ok)
        self.assertEqual(code, C.REASON_DOCK_NOT_FOUND)

    def test_undock_requires_pose(self):
        h = Harness(plant=(0.0, 0.0, 0.0))
        ok, code, text = h.core.start(
            OP_UNDOCK, "req-1",
            make_snap(0.0, h.plant, h.gw, pose=None))
        self.assertFalse(ok)
        self.assertEqual(code, C.REASON_REJECTED)
        self.assertIn("no pose", text)

    def test_undock_not_at_dock(self):
        h = Harness(plant=(5.0, 3.0, 0.0))
        ok, code, text = h.core.start(
            OP_UNDOCK, "req-1",
            make_snap(0.0, h.plant, h.gw))
        self.assertFalse(ok)
        self.assertEqual(code, C.REASON_REJECTED)
        self.assertIn("not at the dock", text)

    def test_invalid_request_id(self):
        h = Harness()
        ok, code, text = h.core.start(
            OP_DOCK, "!!!", make_snap(0.0, h.plant, h.gw))
        self.assertFalse(ok)
        self.assertEqual(code, C.REASON_REJECTED)
        self.assertIn("invalid request_id", text)


class DockHappyPathTest(unittest.TestCase):
    def test_dock_and_charge_confirmed(self):
        h = Harness(battery=charging_battery)
        r = h.run(OP_DOCK, "req-1")
        self.assertTrue(r["ok"])
        self.assertIsNotNone(r["terminal"],
                             "no terminal after {} ticks".format(r["ticks"]))
        success, code, text, extra = r["terminal"]
        self.assertTrue(success)
        self.assertEqual(code, C.REASON_OK)
        self.assertIn("charging", text)
        self.assertEqual(extra, {"charging": True})
        # robot ended at the dock pose
        e_x, e_y, he = DOCK.error(h.plant.pose)
        self.assertLessEqual(abs(e_x), 0.15)
        self.assertLessEqual(abs(e_y), 0.15)
        self.assertLessEqual(abs(he), 0.25)
        # terminal twist is zero
        self.assertEqual(r["last_twist"], (0.0, 0.0))
        # lease was acquired and released
        cid = "docking-req-1"
        self.assertIn("acquire:{}".format(cid), h.gw.commands)
        self.assertIn("release:{}".format(cid), h.gw.commands)
        self.assertEqual(h.gw.owner, "")

    def test_heartbeats_while_holding(self):
        h = Harness(battery=charging_battery)
        r = h.run(OP_DOCK, "req-1")
        self.assertIsNotNone(r["terminal"])
        cid = "docking-req-1"
        hb = [c for c in h.gw.commands if c == "heartbeat:{}".format(cid)]
        self.assertGreaterEqual(len(hb), 3)

    def test_rtd_client_id_reports_returning(self):
        h = Harness()
        ok, _c, _t = h.core.start(
            OP_DOCK, "rtd-xyz", make_snap(0.0, h.plant, h.gw))
        self.assertTrue(ok)
        h.core.update(make_snap(0.05, h.plant, h.gw))
        view = h.core.status_view(make_snap(0.1, h.plant, h.gw))
        self.assertEqual(view["state"], C.STATE_RETURNING)
        h.core.finish()


class ChargeFailureTest(unittest.TestCase):
    def test_charge_not_confirmed(self):
        # dock succeeds, but the BMS never confirms a charge
        h = Harness(params=default_params(charge_window_sec=0.5))
        r = h.run(OP_DOCK, "req-1")
        self.assertIsNotNone(r["terminal"])
        success, code, text, extra = r["terminal"]
        self.assertFalse(success)
        self.assertEqual(code, C.REASON_CHARGE_NOT_CONFIRMED)
        self.assertEqual(extra, {"charging": False})
        self.assertIn("not confirmed", text)
        self.assertIn("release:docking-req-1", h.gw.commands)

    def test_stale_bms_sample_does_not_confirm(self):
        # a dead battery bus: one old sample, then silence
        def battery(now):
            if now < 0.1:
                return BatterySample(current=2.0, stamp=now)
            return None
        h = Harness(battery=battery,
                    params=default_params(charge_window_sec=0.5))
        r = h.run(OP_DOCK, "req-1")
        success, code, _text, _extra = r["terminal"]
        self.assertFalse(success)
        self.assertEqual(code, C.REASON_CHARGE_NOT_CONFIRMED)


class UndockTest(unittest.TestCase):
    def test_undock_happy_path(self):
        h = Harness(plant=(0.0, 0.0, 0.0))
        r = h.run(OP_UNDOCK, "req-1")
        self.assertTrue(r["ok"])
        success, code, text, extra = r["terminal"]
        self.assertTrue(success)
        self.assertEqual(code, C.REASON_OK)
        self.assertIn("undocked", text)
        self.assertGreaterEqual(extra["clearance_m"], 0.6 - 0.05 - 1e-9)
        self.assertIn("release:docking-req-1", h.gw.commands)
        e_x, _e_y, _he = DOCK.error(h.plant.pose)
        self.assertLess(e_x, 0.0)  # behind the dock pose

    def test_undock_moves(self):
        h = Harness(plant=(0.0, 0.0, 0.0))
        h.run(OP_UNDOCK, "req-1")
        # the robot actually reversed away from the dock
        self.assertLess(h.plant.pose[0], -0.5)


class FaultTest(unittest.TestCase):
    def test_cancel_mid_op(self):
        def mutate(i, now, h):
            if i == 100:  # t = 5.0 s, mid-servo
                h.core.request_cancel("req-1")
        h = Harness(mutate=mutate)
        r = h.run(OP_DOCK, "req-1")
        success, code, _text, _extra = r["terminal"]
        self.assertFalse(success)
        self.assertEqual(code, C.REASON_USER_CANCELED)
        self.assertIn("release:docking-req-1", h.gw.commands)

    def test_cancel_wrong_id_ignored(self):
        def mutate(i, now, h):
            if i == 100:
                self.assertFalse(h.core.request_cancel("someone-else"))
        h = Harness(mutate=mutate)
        r = h.run(OP_DOCK, "req-1")
        self.assertIsNotNone(r["terminal"])
        self.assertNotEqual(r["terminal"][1], C.REASON_USER_CANCELED)

    def test_estop_mid_op(self):
        def mutate(i, now, h):
            if i == 100:  # t = 5.0 s, mid-servo
                h.estop = True
        h = Harness(mutate=mutate)
        r = h.run(OP_DOCK, "req-1")
        success, code, text, _extra = r["terminal"]
        self.assertFalse(success)
        self.assertEqual(code, C.REASON_ABORTED)
        self.assertIn("estop", text)

    def test_lease_lost_mid_op(self):
        def mutate(i, now, h):
            if i == 100:
                h.gw.owner = "mission-m9"
        h = Harness(mutate=mutate)
        r = h.run(OP_DOCK, "req-1")
        success, code, text, _extra = r["terminal"]
        self.assertFalse(success)
        self.assertEqual(code, C.REASON_ABORTED)
        self.assertIn("lease lost", text)
        self.assertIn("release:docking-req-1", h.gw.commands)

    def test_acquire_denied(self):
        h = Harness(owner="mission-m9")
        r = h.run(OP_DOCK, "req-1")
        success, code, text, extra = r["terminal"]
        self.assertFalse(success)
        self.assertEqual(code, C.REASON_CONTROL_DENIED)
        self.assertIn("not granted", text)
        # never acquired -> no release issued
        self.assertNotIn("release:docking-req-1", h.gw.commands)
        self.assertEqual(extra, {})

    def test_pose_stale_mid_op(self):
        h = Harness()
        cid = "docking-req-1"
        ok, _c, _t = h.core.start(OP_DOCK, "req-1",
                                  make_snap(0.0, h.plant, h.gw))
        self.assertTrue(ok)
        now = 0.0
        terminal = None
        for i in range(3000):
            pose = h.plant.pose if i < 100 else None  # feed pose for 5 s
            ev = h.core.update(make_snap(now, h.plant, h.gw, pose=pose))
            if ev.acquire:
                h.gw.send(authority.command("acquire", cid))
            if ev.heartbeat:
                h.gw.send(authority.command("heartbeat", cid))
            if ev.twist is not None and pose is not None:
                h.plant.step(*ev.twist)
            if ev.terminal:
                terminal = ev.terminal
                break
            now += DT
        h.core.finish()
        self.assertIsNotNone(terminal)
        success, code, text, _extra = terminal
        self.assertFalse(success)
        self.assertEqual(code, C.REASON_ABORTED)
        self.assertIn("pose stream stale", text)

    def test_pose_never_available(self):
        h = Harness(params=default_params(pose_start_timeout_sec=0.5))
        cid = "docking-req-1"
        ok, _c, _t = h.core.start(OP_DOCK, "req-1",
                                  make_snap(0.0, h.plant, h.gw, pose=None))
        self.assertTrue(ok)
        now = 0.0
        terminal = None
        for i in range(400):
            ev = h.core.update(make_snap(now, h.plant, h.gw, pose=None))
            if ev.acquire:
                h.gw.send(authority.command("acquire", cid))
            if ev.heartbeat:
                h.gw.send(authority.command("heartbeat", cid))
            if ev.terminal:
                terminal = ev.terminal
                break
            now += DT
        h.core.finish()
        self.assertIsNotNone(terminal)
        success, code, text, _extra = terminal
        self.assertFalse(success)
        self.assertEqual(code, C.REASON_ABORTED)
        self.assertIn("not available", text)

    def test_no_auto_retry(self):
        h = Harness()
        r1 = h.run(OP_DOCK, "req-1")
        self.assertIsNotNone(r1["terminal"])
        # after finish() the core is idle: updates produce nothing
        ev = h.core.update(make_snap(0.0, h.plant, h.gw))
        self.assertIsNone(ev.terminal)
        self.assertFalse(ev.acquire)
        self.assertFalse(ev.release)
        self.assertIsNone(h.core.active)
        # ...and a fresh op can start cleanly
        h2 = Harness()
        r2 = h2.run(OP_DOCK, "req-2")
        self.assertTrue(r2["ok"])


class StatusViewTest(unittest.TestCase):
    def _h(self, **kw):
        return Harness(**kw)

    def test_idle(self):
        h = self._h()
        view = h.core.status_view(make_snap(0.0, h.plant, h.gw))
        self.assertEqual(view["state"], C.STATE_IDLE)
        self.assertEqual(view["dock_id"], "dock-a")
        self.assertEqual(view["last_reason_code"], 0)
        self.assertTrue(math.isnan(view["battery_percentage"]))
        # standoff is 0.6 m from the dock pose
        self.assertAlmostEqual(view["dock_pose_error_m"], 0.6, places=6)

    def test_final_approach_during_dock(self):
        h = self._h()
        h.core.start(OP_DOCK, "req-1", make_snap(0.0, h.plant, h.gw))
        h.core.update(make_snap(0.05, h.plant, h.gw))
        view = h.core.status_view(make_snap(0.1, h.plant, h.gw))
        self.assertEqual(view["state"], C.STATE_FINAL_APPROACH)

    def test_undocking(self):
        h = self._h(plant=(0.0, 0.0, 0.0))
        h.core.start(OP_UNDOCK, "req-1", make_snap(0.0, h.plant, h.gw))
        h.core.update(make_snap(0.05, h.plant, h.gw))
        view = h.core.status_view(make_snap(0.1, h.plant, h.gw))
        self.assertEqual(view["state"], C.STATE_UNDOCKING)

    def test_docked_and_charging(self):
        h = self._h()
        # robot parked at the dock pose, BMS says charging
        h.plant.pose = [0.0, 0.0, 0.0]
        h.charge.update(BatterySample(current=2.0, percentage=42.0,
                                      stamp=1.0))
        view = h.core.status_view(
            make_snap(1.0, h.plant, h.gw, pose=(0.0, 0.0, 0.0)))
        self.assertEqual(view["state"], C.STATE_CHARGING)
        self.assertTrue(view["charging"])
        self.assertAlmostEqual(view["battery_percentage"], 42.0)
        self.assertLessEqual(view["dock_pose_error_m"], 0.3)

    def test_docked_not_charging(self):
        h = self._h()
        h.charge.update(BatterySample(current=-1.0, stamp=1.0))
        view = h.core.status_view(
            make_snap(1.0, h.plant, h.gw, pose=(0.0, 0.0, 0.0)))
        self.assertEqual(view["state"], C.STATE_DOCKED)
        self.assertFalse(view["charging"])

    def test_fault_after_failed_op(self):
        def mutate(i, now, h):
            if i == 10:
                h.core.request_cancel("req-1")
        h = self._h(mutate=mutate)
        r = h.run(OP_DOCK, "req-1")
        self.assertFalse(r["terminal"][0])
        view = h.core.status_view(make_snap(0.0, h.plant, h.gw))
        self.assertEqual(view["state"], C.STATE_FAULT)
        self.assertEqual(view["last_reason_code"], C.REASON_USER_CANCELED)
        self.assertNotEqual(view["last_reason_text"], "")

    def test_fault_clears_on_next_terminal(self):
        def mutate(i, now, h):
            if i == 10:
                h.core.request_cancel("req-1")
        h = self._h(mutate=mutate)
        h.run(OP_DOCK, "req-1")  # fails: FAULT until the next terminal
        # next op succeeds
        h.plant.pose = list(STANDBY)
        cid = "docking-req-2"
        ok, _c, _t = h.core.start(OP_DOCK, "req-2",
                                  make_snap(0.0, h.plant, h.gw))
        self.assertTrue(ok)
        now = 0.0
        terminal = None
        for i in range(3000):
            h.charge.update(charging_battery(now))
            ev = h.core.update(make_snap(now, h.plant, h.gw))
            if ev.acquire:
                h.gw.send(authority.command("acquire", cid))
            if ev.heartbeat:
                h.gw.send(authority.command("heartbeat", cid))
            if ev.release:
                h.gw.send(authority.command("release", cid))
            if ev.twist is not None:
                h.plant.step(*ev.twist)
            if ev.terminal:
                terminal = ev.terminal
                break
            now += DT
        h.core.finish()
        self.assertIsNotNone(terminal)
        self.assertTrue(terminal[0])
        h.charge.update(BatterySample(current=2.0, percentage=55.0,
                                      stamp=100.0))
        view = h.core.status_view(
            make_snap(100.0, h.plant, h.gw, pose=(0.0, 0.0, 0.0)))
        self.assertEqual(view["state"], C.STATE_CHARGING)


if __name__ == "__main__":
    unittest.main()
