"""RouteStore tests — pure Python, no ROS required.

Run: python3 -m unittest discover -s test -v
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(
    0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from omni_mission_manager.route_store import (  # noqa: E402
    SIDE_CAR_SCHEMA_VERSION,
    RouteMalformed,
    RouteNotFound,
    RouteStore,
    parse_route_file,
    parse_route_sidecar,
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
        self.assertEqual(info.map_id, "")  # no sidecar: unbound
        self.assertEqual(info.map_version, "")
        self.assertFalse(info.is_bound)
        self.assertEqual(info.num_points, 3)
        self.assertRegex(info.created_at, r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        self.assertEqual(
            self.store.load_points("r1"),
            [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (1.0, 1.0, 0.0)])

    def _write_sidecar(self, route_id, text):
        path = os.path.join(self.routes_dir, route_id + ".route.json")
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path

    def test_load_reads_sidecar_binding(self):
        self._write("r1")
        self._write_sidecar("r1", '{"schema_version": 1, "map_id": "mapA",'
                                  ' "map_version": "v1"}')
        info = self.store.load("r1")
        self.assertTrue(info.is_bound)
        self.assertEqual(info.map_id, "mapA")
        self.assertEqual(info.map_version, "v1")

    def test_load_sidecar_unbound_map_id(self):
        self._write("r1")
        self._write_sidecar("r1", '{"schema_version": 1, "map_id": "",'
                                  ' "map_version": ""}')
        info = self.store.load("r1")
        self.assertFalse(info.is_bound)
        self.assertEqual((info.map_id, info.map_version), ("", ""))

    def test_load_malformed_sidecar_rejected(self):
        self._write("r1")
        self._write_sidecar("r1", "not json")
        with self.assertRaises(RouteMalformed):
            self.store.load("r1")

    def test_list_routes_shows_binding(self):
        self._write("a")
        self._write("b")
        self._write_sidecar("b", '{"schema_version": 1, "map_id": "mapB",'
                                 ' "map_version": "v2"}')
        infos = {i.route_id: i for i in self.store.list_routes()}
        self.assertEqual(infos["a"].map_id, "")
        self.assertEqual(infos["b"].map_id, "mapB")
        self.assertEqual(infos["b"].map_version, "v2")

    def test_list_routes_skips_malformed_sidecar(self):
        self._write("a")
        self._write("b")
        self._write_sidecar("b", '{"schema_version": 99}')
        ids = [i.route_id for i in self.store.list_routes()]
        self.assertEqual(ids, ["a"])

    def test_bind_writes_sidecar(self):
        self._write("r1")
        info = self.store.bind("r1", "mapA", "v1")
        self.assertTrue(info.is_bound)
        self.assertEqual((info.map_id, info.map_version), ("mapA", "v1"))
        with open(os.path.join(self.routes_dir, "r1.route.json"),
                  encoding="utf-8") as f:
            self.assertEqual(json.load(f), {
                "schema_version": SIDE_CAR_SCHEMA_VERSION,
                "map_id": "mapA",
                "map_version": "v1",
            })
        # Rebinding is idempotent and atomic (no temp files left behind).
        self.store.bind("r1", "mapA", "v2")
        self.assertEqual(self.store.load("r1").map_version, "v2")
        leftovers = [n for n in os.listdir(self.routes_dir)
                     if n.startswith(".")]
        self.assertEqual(leftovers, [])

    def test_bind_requires_existing_route(self):
        with self.assertRaises(RouteNotFound):
            self.store.bind("nope", "mapA")

    def test_bind_rejects_bad_ids(self):
        self._write("r1")
        for bad in ("../etc/passwd", "a b", "x" * 65):
            with self.assertRaises(RouteMalformed, msg=bad):
                self.store.bind("r1", bad)
        for bad_version in ("v 1", "x" * 33, "../v"):
            with self.assertRaises(RouteMalformed, msg=bad_version):
                self.store.bind("r1", "mapA", bad_version)

    def test_bind_empty_unbinds(self):
        self._write("r1")
        self.store.bind("r1", "mapA", "v1")
        info = self.store.bind("r1", "")
        self.assertFalse(info.is_bound)
        self.assertFalse(
            os.path.exists(os.path.join(self.routes_dir, "r1.route.json")))
        # Unbinding twice is a no-op.
        self.assertFalse(self.store.bind("r1", "").is_bound)

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


class ParseRouteSidecarTests(unittest.TestCase):
    def _payload(self, **kw):
        base = {"schema_version": 1, "map_id": "mapA", "map_version": ""}
        base.update(kw)
        return json.dumps(base)

    def test_valid(self):
        self.assertEqual(parse_route_sidecar(self._payload()),
                         ("mapA", ""))
        self.assertEqual(
            parse_route_sidecar(self._payload(map_id="", map_version="v12")),
            ("", "v12"))

    def test_bad_json(self):
        with self.assertRaises(RouteMalformed):
            parse_route_sidecar("not json")
        with self.assertRaises(RouteMalformed):
            parse_route_sidecar("")

    def test_non_object(self):
        for text in ("[]", '"mapA"', "1"):
            with self.assertRaises(RouteMalformed):
                parse_route_sidecar(text)

    def test_schema_version(self):
        for bad in (0, 2, "1", True, None):
            with self.assertRaises(RouteMalformed):
                parse_route_sidecar(self._payload(schema_version=bad))

    def test_missing_keys(self):
        for key in ("schema_version", "map_id", "map_version"):
            data = json.loads(self._payload())
            del data[key]
            with self.assertRaises(RouteMalformed):
                parse_route_sidecar(json.dumps(data))

    def test_non_string_values(self):
        for kw in ({"map_id": 1}, {"map_version": 3},
                   {"map_id": None}, {"map_version": []}):
            with self.assertRaises(RouteMalformed):
                parse_route_sidecar(self._payload(**kw))

    def test_bad_map_id(self):
        for bad in ("../x", "a b", "-x", "x" * 65, "a/b", "mapA\n"):
            with self.assertRaises(RouteMalformed):
                parse_route_sidecar(self._payload(map_id=bad))

    def test_bad_map_version(self):
        for bad in ("v 1", "../v", "-v", "x" * 33):
            with self.assertRaises(RouteMalformed):
                parse_route_sidecar(self._payload(map_version=bad))


if __name__ == "__main__":
    unittest.main()
