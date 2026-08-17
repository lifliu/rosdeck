"""Route file access for the Mission Manager (V1).

Routes are recorded with omni_slam's global_path_tools (record_path.py):
a ``# key: value`` header block plus ``x y z`` body points expressed in
the map frame. V1 route files carry no map binding, so ``map_id`` is
always ``""`` (unbound); the MapBundle/RouteStore sidecar arrives in
Phase 2.

Pure Python (no ROS imports) so it is unit-testable off the robot.
"""

import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Tuple

__all__ = [
    "RouteInfo",
    "RouteNotFound",
    "RouteMalformed",
    "RouteStore",
    "parse_route_file",
]

#: First header line written by record_path.py.
ROUTE_FILE_MAGIC = "omni_slam global body path v1"

#: route_ids are file names under the routes dir; keep them boring.
_ROUTE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class RouteNotFound(LookupError):
    """No route file for the requested route_id (or invalid id)."""


class RouteMalformed(ValueError):
    """The route file exists but does not parse."""


@dataclass(frozen=True)
class RouteInfo:
    route_id: str
    path: str
    frame_id: str
    map_id: str  # V1: always "" (route files carry no map binding)
    created_at: str  # ISO-8601 UTC (file mtime, approximate)
    num_points: int

    @property
    def is_bound(self) -> bool:
        return bool(self.map_id)


def _iso_utc(ts) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ")


def parse_route_file(text: str) -> Tuple[Dict[str, str], List[Tuple[float, float, float]]]:
    """Parse record_path.py output: ``# key: value`` header + ``x y z`` rows.

    Raises RouteMalformed on a missing/foreign magic line, data before the
    header, non-numeric or non-finite points, or fewer than 2 points.
    Duplicate header keys: last wins.
    """
    header: Dict[str, str] = {}
    points: List[Tuple[float, float, float]] = []
    saw_magic = False
    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            body = line[1:].strip()
            if not saw_magic:
                if body != ROUTE_FILE_MAGIC:
                    raise RouteMalformed(
                        "line %d: expected magic %r, got %r"
                        % (lineno, ROUTE_FILE_MAGIC, body))
                saw_magic = True
                continue
            if ":" not in body:
                raise RouteMalformed(
                    "line %d: malformed header %r" % (lineno, line))
            key, _, value = body.partition(":")
            header[key.strip()] = value.strip()
            continue
        if not saw_magic:
            raise RouteMalformed("line %d: data before magic header" % lineno)
        parts = line.split()
        if len(parts) != 3:
            raise RouteMalformed(
                "line %d: expected 'x y z', got %r" % (lineno, line))
        try:
            x, y, z = (float(p) for p in parts)
        except ValueError:
            raise RouteMalformed(
                "line %d: non-numeric point %r" % (lineno, line))
        if not all(math.isfinite(v) for v in (x, y, z)):
            raise RouteMalformed("line %d: non-finite point %r" % (lineno, line))
        points.append((x, y, z))
    if not saw_magic:
        raise RouteMalformed("missing magic header line")
    if len(points) < 2:
        raise RouteMalformed("route needs at least 2 points, got %d" % len(points))
    return header, points


class RouteStore:
    """Reads ``<routes_dir>/<route_id>.txt`` route files."""

    def __init__(self, routes_dir):
        self.routes_dir = Path(routes_dir)

    def _resolve(self, route_id) -> Path:
        if not route_id or not _ROUTE_ID_RE.match(route_id):
            raise RouteNotFound("invalid route_id: %r" % (route_id,))
        candidate = (self.routes_dir / (route_id + ".txt")).resolve()
        # route_id is filename-only by regex, but stay strict about the
        # resolved location as well (symlinks / relative routes_dir).
        if candidate.parent != self.routes_dir.resolve():
            raise RouteNotFound(
                "route escapes the routes dir: %r" % (route_id,))
        if not candidate.is_file():
            raise RouteNotFound("no such route: %r" % (route_id,))
        return candidate

    def exists(self, route_id) -> bool:
        try:
            self._resolve(route_id)
            return True
        except RouteNotFound:
            return False

    def load(self, route_id) -> RouteInfo:
        path = self._resolve(route_id)
        header, points = parse_route_file(path.read_text(encoding="utf-8"))
        return RouteInfo(
            route_id=route_id,
            path=str(path),
            frame_id=header.get("frame_id", ""),
            map_id="",  # V1: unbound
            created_at=_iso_utc(path.stat().st_mtime),
            num_points=len(points),
        )

    def load_points(self, route_id) -> List[Tuple[float, float, float]]:
        path = self._resolve(route_id)
        _header, points = parse_route_file(path.read_text(encoding="utf-8"))
        return points

    def list_routes(self) -> List[RouteInfo]:
        """All parseable routes, sorted by route_id. Unparseable files are
        skipped (and logged by the caller if it cares)."""
        if not self.routes_dir.is_dir():
            return []
        out: List[RouteInfo] = []
        for entry in sorted(self.routes_dir.iterdir()):
            if not entry.is_file() or entry.suffix != ".txt":
                continue
            if not _ROUTE_ID_RE.match(entry.stem):
                continue
            try:
                header, points = parse_route_file(
                    entry.read_text(encoding="utf-8"))
            except (RouteMalformed, OSError, UnicodeDecodeError):
                continue
            out.append(RouteInfo(
                route_id=entry.stem,
                path=str(entry),
                frame_id=header.get("frame_id", ""),
                map_id="",
                created_at=_iso_utc(entry.stat().st_mtime),
                num_points=len(points),
            ))
        return out