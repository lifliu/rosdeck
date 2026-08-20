"""approach controller tests — fake-plant integration, no ROS.

The plant is an omnidirectional point integrator at dt = 0.05 s
(20 Hz, the node's servo rate): the robot follows the Twist it is
given, so convergence here means the closed loop works.

Run: python3 -m unittest discover -s test -v
"""

import math
import os
import sys
import unittest

sys.path.insert(
    0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from omni_docking.approach import (  # noqa: E402
    ApproachController, UndockController)
from omni_docking.dock_config import DockPose  # noqa: E402

DT = 0.05


def _wrap(a):
    return (a + math.pi) % (2 * math.pi) - math.pi


class Plant:
    """Omnidirectional point robot: pose (x, y, yaw) in the map frame."""

    def __init__(self, pose):
        self.pose = list(pose)

    def step(self, linear, angular, dt=DT):
        x, y, yaw = self.pose
        yaw = _wrap(yaw + angular * dt)
        x += linear * math.cos(yaw) * dt
        y += linear * math.sin(yaw) * dt
        self.pose = [x, y, yaw]

    def x(self):
        return self.pose[0]

    def e(self, dock):
        return dock.error(self.pose)


def run_approach(dock, plant, max_ticks=2000):
    """Closed-loop dock servo. Returns (ticks, final_tick, done)."""
    ctl = ApproachController(dock)
    for i in range(max_ticks):
        tick = ctl.step(plant.pose)
        plant.step(tick.linear, tick.angular)
        if tick.done:
            return (i + 1, tick, True)
    return (max_ticks, tick, False)


def run_undock(dock, plant, max_ticks=2000):
    ctl = UndockController(dock)
    for i in range(max_ticks):
        tick = ctl.step(plant.pose)
        plant.step(tick.linear, tick.angular)
        if tick.done:
            return (i + 1, tick, True)
    return (max_ticks, tick, False)


# Dock at the origin, facing +x (facing the dock face): the approach
# side is -x.
DOCK = DockPose(0.0, 0.0, 0.0, 0.6)


class DockConvergenceTest(unittest.TestCase):
    def test_straight_from_standoff(self):
        plant = Plant((-0.6, 0.0, 0.0))  # standoff, facing the dock
        ticks, tick, done = run_approach(DOCK, plant)
        self.assertTrue(done, "did not converge in {} ticks".format(ticks))
        e_x, e_y, he = plant.e(DOCK)
        self.assertLessEqual(abs(e_x), 0.15)
        self.assertLessEqual(abs(e_y), 0.15)
        self.assertLessEqual(abs(he), 0.25)
        self.assertEqual(tick.linear, 0.0)
        self.assertEqual(tick.angular, 0.0)
        self.assertEqual(tick.progress, 1.0)

    def test_from_offset_and_ahead(self):
        # 1.2 m behind and 0.3 m to the side, heading a bit off
        plant = Plant((-1.2, 0.3, 0.3))
        ticks, _tick, done = run_approach(DOCK, plant, max_ticks=3000)
        self.assertTrue(done, "did not converge in {} ticks".format(ticks))
        e_x, e_y, he = plant.e(DOCK)
        self.assertLessEqual(abs(e_x), 0.15)
        self.assertLessEqual(abs(e_y), 0.15)
        self.assertLessEqual(abs(he), 0.25)

    def test_facing_away_rotates_first(self):
        plant = Plant((-0.9, 0.0, math.pi))  # facing away from the dock
        ctl = ApproachController(DOCK)
        tick = ctl.step(plant.pose)
        self.assertEqual(tick.linear, 0.0)   # rotate in place first
        self.assertNotEqual(tick.angular, 0.0)
        ticks, _t, done = run_approach(DOCK, plant, max_ticks=3000)
        self.assertTrue(done, "did not converge in {} ticks".format(ticks))
        e_x, e_y, he = plant.e(DOCK)
        self.assertLessEqual(abs(he), 0.25)

    def test_facing_dock_from_standoff_rotated_dock(self):
        # Dock facing +y; approach side is -y
        dock = DockPose(0.0, 0.0, math.pi / 2, 0.6)
        plant = Plant((0.0, -0.6, math.pi / 2))
        ticks, _tick, done = run_approach(dock, plant)
        self.assertTrue(done, "did not converge in {} ticks".format(ticks))
        e_x, e_y, he = dock.error(plant.pose)
        self.assertLessEqual(abs(e_x), 0.15)
        self.assertLessEqual(abs(e_y), 0.15)
        self.assertLessEqual(abs(he), 0.25)

    def test_progress_reaches_one(self):
        plant = Plant((-0.6, 0.0, 0.0))
        ctl = ApproachController(DOCK)
        last = None
        for _ in range(2000):
            last = ctl.step(plant.pose)
            plant.step(last.linear, last.angular)
            if last.done:
                break
        self.assertEqual(last.progress, 1.0)
        self.assertEqual(last.remaining, last.remaining)  # sanity
        e_x, e_y, _he = plant.e(DOCK)
        self.assertAlmostEqual(last.remaining, math.hypot(e_x, e_y), places=6)


class SpeedCapTest(unittest.TestCase):
    def test_standoff_speed_outside_band(self):
        plant = Plant((-1.0, 0.0, 0.0))
        ctl = ApproachController(DOCK)
        tick = ctl.step(plant.pose)
        self.assertLess(tick.linear, 0.15 + 1e-9)

    def test_final_band_speed(self):
        plant = Plant((-0.1, 0.0, 0.0))
        ctl = ApproachController(DOCK)
        tick = ctl.step(plant.pose)
        self.assertLessEqual(tick.linear, 0.05 + 1e-9)

    def test_lateral_error_halves_speed(self):
        ctl = ApproachController(DOCK)
        aligned = ctl.step((-1.0, 0.0, 0.0))
        off = ApproachController(DOCK).step((-1.0, 0.5, math.atan2(0.5, 1.0)))
        # 0.5 m lateral > 2 * 0.15: committed speed is halved
        self.assertLess(off.linear, aligned.linear)

    def test_no_crabbing_when_misaligned(self):
        ctl = ApproachController(DOCK)
        for pose in ((-1.0, 0.0, 2.0), (-1.0, -0.4, -1.8), (0.0, 1.0, 0.0)):
            tick = ctl.step(pose)
            self.assertEqual(tick.linear, 0.0,
                             "crabbed at {!r}: {!r}".format(pose, tick))


class UndockTest(unittest.TestCase):
    def test_backs_off_from_docked_pose(self):
        plant = Plant((0.0, 0.0, 0.0))  # docked, facing the dock
        ticks, tick, done = run_undock(DOCK, plant)
        self.assertTrue(done, "did not clear in {} ticks".format(ticks))
        self.assertGreaterEqual(tick.clearance, 0.6 - 0.05 - 1e-9)
        self.assertLess(tick.clearance, 0.75)
        e_x, _e_y, he = plant.e(DOCK)
        self.assertLessEqual(e_x, -(0.6 - 0.05) + 1e-9)
        self.assertLessEqual(abs(he), 0.25)  # stayed square

    def test_negative_linear_while_reversing(self):
        plant = Plant((0.0, 0.0, 0.0))
        ctl = UndockController(DOCK)
        tick = ctl.step(plant.pose)
        self.assertAlmostEqual(tick.linear, -0.15)
        self.assertFalse(tick.done)

    def test_from_slightly_off_pose(self):
        plant = Plant((0.05, 0.03, 0.15))
        ticks, tick, done = run_undock(DOCK, plant)
        self.assertTrue(done, "did not clear in {} ticks".format(ticks))
        self.assertGreaterEqual(tick.clearance, 0.6 - 0.05 - 1e-9)

    def test_already_cleared(self):
        plant = Plant((-0.7, 0.0, 0.0))
        ctl = UndockController(DOCK)
        tick = ctl.step(plant.pose)
        self.assertTrue(tick.done)
        self.assertAlmostEqual(tick.clearance, 0.7)

    def test_progress_monotonic(self):
        plant = Plant((0.0, 0.0, 0.0))
        ctl = UndockController(DOCK)
        last = 0.0
        for _ in range(2000):
            tick = ctl.step(plant.pose)
            self.assertGreaterEqual(tick.progress, last - 1e-9)
            last = tick.progress
            plant.step(tick.linear, tick.angular)
            if tick.done:
                break
        self.assertEqual(tick.progress, 1.0)

    def test_misaligned_rotates_first(self):
        plant = Plant((0.0, 0.0, math.pi))  # facing away from the dock
        ctl = UndockController(DOCK)
        tick = ctl.step(plant.pose)
        self.assertEqual(tick.linear, 0.0)
        self.assertNotEqual(tick.angular, 0.0)


if __name__ == "__main__":
    unittest.main()
