"""dock_config tests — pure Python, no ROS required.

Run: python3 -m unittest discover -s test -v
"""

import json
import math
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(
    0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from omni_docking.dock_config import (  # noqa: E402
    DockConfigError, DockConfigStore, parse_dock_file, write_dock_file)


def good_doc(**over):
    doc = {
        "schema_version": 1,
        "map_id": "m1",
        "map_version": "",
        "dock_id": "dock-a",
        "pose": [1.0, 2.0, 0.5],
        "approach_distance": 0.6,
    }
    doc.update(over)
    return doc


class ParseTest(unittest.TestCase):
    def test_valid(self):
        cfg = parse_dock_file(json.dumps(good_doc()))
        self.assertEqual(cfg.map_id, "m1")
        self.assertEqual(cfg.dock_id, "dock-a")
        self.assertAlmostEqual(cfg.pose.x, 1.0)
        self.assertAlmostEqual(cfg.pose.yaw, 0.5)
        self.assertAlmostEqual(cfg.pose.approach_distance, 0.6)
        self.assertGreater(cfg.at_dock_tolerance, 0.6)

    def test_bad_json(self):
        with self.assertRaises(DockConfigError):
            parse_dock_file("{not json")

    def test_wrong_schema(self):
        with self.assertRaises(DockConfigError):
            parse_dock_file(json.dumps(good_doc(schema_version=99)))

    def test_missing_map_id(self):
        doc = good_doc()
        del doc["map_id"]
        with self.assertRaises(DockConfigError):
            parse_dock_file(json.dumps(doc))

    def test_bad_pose(self):
        for pose in (1.0, [1.0, 2.0], ["a", 2.0, 0.5], [1, 2, 3, 4]):
            with self.assertRaises(DockConfigError):
                parse_dock_file(json.dumps(good_doc(pose=pose)))

    def test_nan_pose(self):
        with self.assertRaises(DockConfigError):
            parse_dock_file(json.dumps(
                good_doc(pose=[float("nan"), 2.0, 0.5])))

    def test_bad_approach(self):
        for v in (0.1, 5.0, "0.6", True):
            with self.assertRaises(DockConfigError):
                parse_dock_file(json.dumps(good_doc(approach_distance=v)))

    def test_non_object_top(self):
        with self.assertRaises(DockConfigError):
            parse_dock_file(json.dumps([1, 2, 3]))


class DockPoseGeometryTest(unittest.TestCase):
    def test_error_identity(self):
        from omni_docking.dock_config import DockPose
        d = DockPose(1.0, 2.0, 0.0, 0.6)
        e_x, e_y, he = d.error((1.0, 2.0, 0.0))
        self.assertAlmostEqual(e_x, 0.0)
        self.assertAlmostEqual(e_y, 0.0)
        self.assertAlmostEqual(he, 0.0)

    def test_error_along_axis(self):
        from omni_docking.dock_config import DockPose
        d = DockPose(0.0, 0.0, 0.0, 0.6)  # axis = +x
        e_x, e_y, he = d.error((1.2, 0.0, 0.0))
        self.assertAlmostEqual(e_x, 1.2)
        self.assertAlmostEqual(e_y, 0.0)

    def test_error_rotated_90(self):
        from omni_docking.dock_config import DockPose
        d = DockPose(0.0, 0.0, math.pi / 2, 0.6)  # axis = +y
        # robot at world +x is to the RIGHT of the axis: e_y < 0
        e_x, e_y, he = d.error((1.0, 0.0, math.pi / 2))
        self.assertAlmostEqual(e_x, 0.0)
        self.assertAlmostEqual(e_y, -1.0)
        self.assertAlmostEqual(he, 0.0)

    def test_heading_wrap(self):
        from omni_docking.dock_config import DockPose
        d = DockPose(0.0, 0.0, 0.0, 0.6)
        # 2pi - 0.1 wraps to -0.1
        _e_x, _e_y, he = d.error((1.0, 0.0, 2 * math.pi - 0.1))
        self.assertAlmostEqual(he, -0.1, places=9)
        self.assertLess(abs(he), math.pi)

    def test_standoff(self):
        from omni_docking.dock_config import DockPose
        # Dock at origin facing +x: the standoff park point is behind
        # the dock pose (approach side, -yaw).
        d = DockPose(0.0, 0.0, 0.0, 0.6)
        sx, sy, syaw = d.standoff_pose()
        self.assertAlmostEqual(sx, -0.6)
        self.assertAlmostEqual(sy, 0.0)
        self.assertAlmostEqual(syaw, 0.0)

    def test_standoff_rotated(self):
        from omni_docking.dock_config import DockPose
        d = DockPose(1.0, 1.0, math.pi, 0.5)  # facing -x
        sx, sy, syaw = d.standoff_pose()
        self.assertAlmostEqual(sx, 1.5)
        self.assertAlmostEqual(sy, 1.0)
        self.assertAlmostEqual(syaw, math.pi)


class VersionMatchTest(unittest.TestCase):
    def test_unpin_serves_any(self):
        cfg = parse_dock_file(json.dumps(good_doc()))
        self.assertTrue(cfg.matches(""))
        self.assertTrue(cfg.matches("3"))
        self.assertTrue(cfg.matches(None))

    def test_pinned_serves_only_that(self):
        cfg = parse_dock_file(json.dumps(good_doc(map_version="3")))
        self.assertTrue(cfg.matches("3"))
        self.assertFalse(cfg.matches("4"))
        self.assertFalse(cfg.matches(""))


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)

    def _write(self, name, doc):
        path = os.path.join(self.dir, name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(doc if isinstance(doc, str) else json.dumps(doc))
        return path

    def test_load_and_look_up(self):
        self._write("m1.dock.json", good_doc())
        self._write("m2.dock.json", good_doc(map_id="m2", dock_id="dock-b"))
        self._write("notes.txt", "ignored")
        store = DockConfigStore(self.dir)
        n, errors = store.load()
        self.assertEqual(n, 2)
        self.assertEqual(errors, [])
        self.assertIsNotNone(store.look_up("m1", ""))
        self.assertIsNotNone(store.look_up("m2", "7"))
        self.assertIsNone(store.look_up("m3", ""))
        self.assertIsNone(store.look_up("", ""))

    def test_missing_dir(self):
        store = DockConfigStore("/nonexistent/docks")
        n, errors = store.load()
        self.assertEqual(n, 0)
        self.assertEqual(errors, [])
        self.assertIsNone(store.look_up("m1", ""))

    def test_malformed_strict_raises(self):
        self._write("m1.dock.json", "{broken")
        store = DockConfigStore(self.dir)
        with self.assertRaises(DockConfigError):
            store.load()

    def test_malformed_nonstrict_skips(self):
        self._write("m1.dock.json", "{broken")
        self._write("m2.dock.json", good_doc(map_id="m2"))
        store = DockConfigStore(self.dir)
        n, errors = store.load(strict=False)
        self.assertEqual(n, 1)
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0][0], "m1")
        self.assertIsNone(store.look_up("m1", ""))
        self.assertIsNotNone(store.look_up("m2", ""))

    def test_map_id_mismatch(self):
        self._write("m1.dock.json", good_doc(map_id="other"))
        store = DockConfigStore(self.dir)
        with self.assertRaises(DockConfigError):
            store.load()
        n, errors = store.load(strict=False)
        self.assertEqual(n, 0)
        self.assertEqual(len(errors), 1)

    def test_reload_picks_up_changes(self):
        self._write("m1.dock.json", good_doc())
        store = DockConfigStore(self.dir)
        store.load()
        self.assertIsNotNone(store.look_up("m1", ""))
        os.unlink(os.path.join(self.dir, "m1.dock.json"))
        store.load()
        self.assertIsNone(store.look_up("m1", ""))


class WriteFileTest(unittest.TestCase):
    def test_round_trip(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        path = write_dock_file(d, "m1", "", "dock-a", (1.0, 2.0, 0.5), 0.6)
        self.assertTrue(os.path.exists(path))
        with open(path, "r", encoding="utf-8") as fh:
            cfg = parse_dock_file(fh.read())
        self.assertEqual(cfg.map_id, "m1")
        self.assertAlmostEqual(cfg.pose.yaw, 0.5)
        # no tmp file left behind
        self.assertEqual(
            [f for f in os.listdir(d) if f.endswith(".tmp")], [])


if __name__ == "__main__":
    unittest.main()