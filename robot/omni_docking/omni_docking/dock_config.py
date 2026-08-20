"""Per-map charging-dock configuration.

One JSON file per map in ``docks_dir``:

  <map_id>.dock.json
  {
    "schema_version": 1,
    "map_id": "floor1",
    "map_version": "",            // "" = any/current version
    "dock_id": "dock-a",
    "pose": [x, y, yaw],          // map frame; yaw = heading the robot
                                  // faces when docked (axis toward dock)
    "approach_distance": 0.6      // standoff along the dock axis where
                                  // the robot parks before final approach
  }

V1 rule: at most one dock per map (the file *is* the dock). The file
convention mirrors the RouteStore / checkpoint sidecars (pure JSON,
fail-closed on malformed input, atomic writes for future edit tooling).

The pose is the robot's *final docked* pose: the servo drives the robot
center to it, facing the dock face (yaw = heading toward the dock). The
approach axis is the dock's yaw direction; the robot arrives from
behind (the -yaw side) and parks at the approach_distance standoff
before the final approach.
"""

import json
import math
import os
import tempfile

SCHEMA_VERSION = 1


class DockConfigError(Exception):
    """A dock config file exists but is unreadable/malformed."""


class DockPose:
    """Final docked pose in the map frame, plus the approach geometry."""

    __slots__ = ("x", "y", "yaw", "approach_distance")

    def __init__(self, x, y, yaw, approach_distance):
        self.x = float(x)
        self.y = float(y)
        self.yaw = float(yaw)
        self.approach_distance = float(approach_distance)

    @property
    def axis(self):
        """Unit vector of the dock axis (robot's facing when docked)."""
        return (math.cos(self.yaw), math.sin(self.yaw))

    def standoff_pose(self):
        """(x, y, yaw) of the park point before the final approach:
        approach_distance behind the dock pose, facing the dock."""
        ax, ay = self.axis
        return (self.x - ax * self.approach_distance,
                self.y - ay * self.approach_distance,
                self.yaw)

    def error(self, pose):
        """(e_x, e_y, heading_error) of the robot in the dock frame.

        e_x > 0: robot on the dock side of the dock pose (past the
        contact point); e_x < 0: robot on the approach side.
        e_y > 0: robot to the left of the axis. heading_error is wrapped
        to [-pi, pi], zero when the robot faces the dock.
        """
        dx = pose[0] - self.x
        dy = pose[1] - self.y
        ax, ay = self.axis
        e_x = dx * ax + dy * ay
        e_y = -dx * ay + dy * ax
        return (e_x, e_y, _wrap_angle(pose[2] - self.yaw))

    def distance(self, pose):
        return math.hypot(pose[0] - self.x, pose[1] - self.y)


class DockConfig:
    """A parsed <map_id>.dock.json entry."""

    __slots__ = ("map_id", "map_version", "dock_id", "pose",
                 "at_dock_tolerance")

    def __init__(self, map_id, map_version, dock_id, pose):
        self.map_id = map_id
        self.map_version = map_version  # "" = any/current version
        self.dock_id = dock_id
        self.pose = pose
        # How close the robot must be to count as "at the dock" (undock
        # gate / DockStatus docked detection).
        self.at_dock_tolerance = max(pose.approach_distance, 0.5) + 0.3

    def matches(self, map_version):
        """V1: the entry serves its map for any requested version unless
        it pins a specific one; a request for the current version ("")
        is only served by an unpinned entry."""
        if self.map_version == "":
            return True
        if map_version in ("", None):
            return False
        return self.map_version == str(map_version)


def _wrap_angle(a):
    return (a + math.pi) % (2 * math.pi) - math.pi


def parse_dock_file(text, source="<string>"):
    """Parse one dock JSON document into a DockConfig.

    Raises DockConfigError on any malformed field (fail-closed: a broken
    config must not silently produce a wrong dock pose).
    """
    try:
        doc = json.loads(text)
    except (ValueError, TypeError) as exc:
        raise DockConfigError("{}: invalid JSON: {}".format(source, exc))
    if not isinstance(doc, dict):
        raise DockConfigError("{}: top level must be an object".format(source))
    if doc.get("schema_version") != SCHEMA_VERSION:
        raise DockConfigError(
            "{}: unsupported schema_version {!r} (want {})".format(
                source, doc.get("schema_version"), SCHEMA_VERSION))
    map_id = doc.get("map_id")
    if not isinstance(map_id, str) or not map_id:
        raise DockConfigError("{}: map_id must be a non-empty string".format(source))
    map_version = doc.get("map_version", "")
    if not isinstance(map_version, str):
        raise DockConfigError("{}: map_version must be a string".format(source))
    dock_id = doc.get("dock_id")
    if not isinstance(dock_id, str) or not dock_id:
        raise DockConfigError("{}: dock_id must be a non-empty string".format(source))
    pose = doc.get("pose")
    if (not isinstance(pose, (list, tuple)) or len(pose) != 3
            or not all(isinstance(v, (int, float)) for v in pose)):
        raise DockConfigError(
            "{}: pose must be [x, y, yaw] numbers".format(source))
    approach = doc.get("approach_distance")
    if (not isinstance(approach, (int, float)) or isinstance(approach, bool)
            or not (0.2 <= float(approach) <= 3.0)):
        raise DockConfigError(
            "{}: approach_distance must be a number in [0.2, 3.0] m".format(source))
    if any(math.isnan(float(v)) or math.isinf(float(v)) for v in list(pose) + [approach]):
        raise DockConfigError("{}: pose/approach values must be finite".format(source))
    cfg = DockConfig(map_id, map_version, dock_id,
                     DockPose(pose[0], pose[1], pose[2], approach))
    return cfg


class DockConfigStore:
    """Loads <map_id>.dock.json files from a directory.

    load() raises DockConfigError on the first malformed file (fail
    closed). look_up(map_id, map_version) returns the matching
    DockConfig or None; a map with a malformed file simply has no entry
    after a load that skipped it (the node re-raises to the caller).
    """

    def __init__(self, docks_dir):
        self.dir = docks_dir
        self._entries = {}  # map_id -> DockConfig

    def load(self, strict=True):
        """(Re)read the directory. Returns (loaded, errors): errors is a
        list of (map_id, message). In strict mode the first error
        raises; non-strict skips the file and records it."""
        entries = {}
        errors = []
        if not self.dir or not os.path.isdir(self.dir):
            return (0, errors)
        for name in sorted(os.listdir(self.dir)):
            if not name.endswith(".dock.json"):
                continue
            map_id = name[: -len(".dock.json")]
            path = os.path.join(self.dir, name)
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    cfg = parse_dock_file(fh.read(), source=name)
            except DockConfigError as exc:
                if strict:
                    raise
                errors.append((map_id, str(exc)))
                continue
            if cfg.map_id != map_id:
                if strict:
                    raise DockConfigError(
                        "{}: map_id {!r} does not match file name".format(
                            name, cfg.map_id))
                errors.append((map_id,
                               "map_id {!r} does not match file name".format(
                                   cfg.map_id)))
                continue
            if map_id in entries:
                if strict:
                    raise DockConfigError(
                        "{}: duplicate dock entry for map {!r}".format(
                            name, map_id))
                errors.append((map_id, "duplicate dock entry, keeping first"))
                continue
            entries[map_id] = cfg
        self._entries = entries
        return (len(entries), errors)

    @property
    def entries(self):
        return dict(self._entries)

    def look_up(self, map_id, map_version=""):
        """The DockConfig serving this map/version, or None."""
        cfg = self._entries.get(map_id or "")
        if cfg is None or not map_id:
            return None
        if cfg.matches(map_version):
            return cfg
        return None


def write_dock_file(docks_dir, map_id, map_version, dock_id, pose,
                    approach_distance):
    """Atomic write (tmp + rename), for future edit tooling / tests.
    Mirrors RouteStore.bind()."""
    doc = {
        "schema_version": SCHEMA_VERSION,
        "map_id": map_id,
        "map_version": map_version,
        "dock_id": dock_id,
        "pose": [pose[0], pose[1], pose[2]],
        "approach_distance": approach_distance,
    }
    os.makedirs(docks_dir, exist_ok=True)
    path = os.path.join(docks_dir, "{}.dock.json".format(map_id))
    fd, tmp = tempfile.mkstemp(dir=docks_dir, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return path
