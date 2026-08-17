"""RouteStore tests — pure Python, no ROS required.

Run: python3 -m unittest discover -s test -v
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(
    0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from omni_mission_manager.route_store import (  # noqa: E402
    RouteMalformed,
    RouteNotFound,
    RouteStore,
    parse_route_file,
)

SAMPLE = """\
# omni_slam global body path v1
# frame_id: lio_map
# child_frame_id: scan_base_link
# source_topic: /body/odom
# body_to_sensor_xyz: 0.12 0.0 0.05
# body_to_sensor_rpy: 0.0 0.0 0.0
# columns: x y z
0.0 0.0 0.0
1.0 0.0 0.0
1.0 1.0 0.0
"""


class RouteStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.routes_dir = os.path.join(self.tmp.name, "routes")
        os.makedirs(self.routes_dir)
        self.store = RouteStore(self.routes_dir)

    def _write(self, route_id, text=SAMPLE):
        path = os.path.join(self.routes_dir, route_id + ".txt")
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path

    def test_load_parses_header_and_points(self):
        self._write("r1")
        info = self.store.load("r1")
        self.assertEqual(info.route_id, "r1")
        self.assertEqual(info.frame_id, "lio_map")
        self.assertEqual(info.map_id, "")  # V1: unbound
        self.assertFalse(info.is_bound)
        self.assertEqual(info.num_points, 3)
        self.assertRegex(info.created_at, r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        self.assertEqual(
            self.store.load_points("r1"),
            [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (1.0, 1.0, 0.0)])

    def test_list_routes_sorted_and_filtered(self):
        self._write("b")
        self._write("a")
        with open(os.path.join(self.routes_dir, "notaroute"), "w") as f:
            f.write(SAMPLE)  # no .txt suffix -> ignored
        with open(os.path.join(self.routes_dir, "bad.txt"), "w") as f:
            f.write("garbage\n")  # unparseable -> skipped
        ids = [i.route_id for i in self.store.list_routes()]
        self.assertEqual(ids, ["a", "b"])

    def test_missing_route(self):
        with self.assertRaises(RouteNotFound):
            self.store.load("nope")
        self.assertFalse(self.store.exists("nope"))

    def test_invalid_route_ids(self):
        for bad in ("", "../etc/passwd", "a/b", ".hidden", "x" * 200):
            with self.assertRaises(RouteNotFound, msg=bad):
                self.store.load(bad)

    def test_traversal_rejected(self):
        # A file that resolves outside the routes dir must not load.
        outside = os.path.join(self.tmp.name, "outside.txt")
        with open(outside, "w") as f:
            f.write(SAMPLE)
        link = os.path.join(self.routes_dir, "link.txt")
        os.symlink(outside, link)
        # 'link' resolves to the parent dir's file -> rejected.
        with self.assertRaises(RouteNotFound):
            self.store.load("link")

    def test_empty_routes_dir(self):
        empty = os.path.join(self.tmp.name, "empty")
        os.makedirs(empty)
        self.assertEqual(RouteStore(empty).list_routes(), [])

    def test_missing_routes_dir(self):
        self.assertEqual(
            RouteStore(os.path.join(self.tmp.name, "nope")).list_routes(), [])


class ParseRouteFileTests(unittest.TestCase):
    def test_header_values(self):
        header, points = parse_route_file(SAMPLE)
        self.assertEqual(header["frame_id"], "lio_map")
        self.assertEqual(header["source_topic"], "/body/odom")
        self.assertEqual(len(points), 3)

    def test_bad_magic(self):
        with self.assertRaises(RouteMalformed):
            parse_route_file("# wrong magic\n# frame_id: m\n0 0 0\n1 0 0\n")

    def test_data_before_header(self):
        with self.assertRaises(RouteMalformed):
            parse_route_file("0 0 0\n1 0 0\n")

    def test_non_numeric(self):
        text = SAMPLE.replace("1.0 1.0 0.0", "1.0 foo 0.0")
        with self.assertRaises(RouteMalformed):
            parse_route_file(text)

    def test_non_finite(self):
        text = SAMPLE.replace("1.0 1.0 0.0", "nan 1.0 0.0")
        with self.assertRaises(RouteMalformed):
            parse_route_file(text)

    def test_short_row(self):
        text = SAMPLE.replace("1.0 1.0 0.0", "1.0 1.0")
        with self.assertRaises(RouteMalformed):
            parse_route_file(text)

    def test_too_few_points(self):
        text = SAMPLE.splitlines()[:7]  # header only
        text.append("0 0 0")
        with self.assertRaises(RouteMalformed):
            parse_route_file("\n".join(text))

    def test_empty_file(self):
        with self.assertRaises(RouteMalformed):
            parse_route_file("")


if __name__ == "__main__":
    unittest.main()