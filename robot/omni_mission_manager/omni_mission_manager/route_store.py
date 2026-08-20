"""Route file access for the Mission Manager.

Routes are recorded with omni_slam's global_path_tools (record_path.py):
a ``# key: value`` header block plus ``x y z`` body points expressed in
the map frame.

Map binding: a route is bound to a map through a sidecar file
``<route_id>.route.json`` next to the ``<route_id>.txt`` route file::

    {"schema_version": 1, "map_id": "mapA", "map_version": ""}

``map_version`` of ``""`` means "current version" (same convention as
``DispatchMission.map_version``). An absent sidecar means the route is
unbound (the V1 state). The dispatch gate
(``state_machine.dispatch``) then enforces that the goal's, the route's,
and the robot's map identity agree. A malformed sidecar is fail-closed:
``load()`` raises ``RouteMalformed`` and ``list_routes()`` skips the
entry, so a broken binding never silently turns a bound route into an
unbound one.

Pure Python (no ROS imports) so it is unit-testable off the robot.
"""

import json
import math
import os
import re
import uuid
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
    "parse_route_sidecar",
]

#: First header line written by record_path.py.
ROUTE_FILE_MAGIC = "omni_slam global body path v1"

#: route_ids are file names under the routes dir; keep them boring.
_ROUTE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

#: Sidecar file suffix next to ``<route_id>.txt``.
SIDE_CAR_SUFFIX = ".route.json"

#: Only known sidecar schema; bump when the binding shape changes.
SIDE_CAR_SCHEMA_VERSION = 1

#: Mirrors omni_slam MapStore's map_id grammar.
_MAP_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")

#: Boring version token ("" = current version). The IDL carries versions
#: as free-form strings; we only forbid path separators / whitespace.
_MAP_VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$")


class RouteNotFound(LookupError):
    """No route file for the requested route_id (or invalid id)."""


class RouteMalformed(ValueError):
    """The route file exists but does not parse."""


@dataclass(frozen=True)
class RouteInfo:
    route_id: str
    path: str
    frame_id: str
    map_id: str  # "" = unbound (no sidecar)
    map_version: str  # "" = current version
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


def _validate_binding(map_id, map_version) -> None:
    if not isinstance(map_id, str) or not isinstance(map_version, str):
        raise RouteMalformed("sidecar map_id/map_version must be strings")
    if map_id and not _MAP_ID_RE.fullmatch(map_id):
        raise RouteMalformed("sidecar map_id %r is not a valid map id" % map_id)
    if map_version and not _MAP_VERSION_RE.fullmatch(map_version):
        raise RouteMalformed(
            "sidecar map_version %r is not a valid version" % map_version)


def parse_route_sidecar(text: str) -> Tuple[str, str]:
    """Parse a ``<route_id>.route.json`` map binding sidecar.

    Returns ``(map_id, map_version)``; ``map_id == ""`` means unbound and
    ``map_version == ""`` means the map's current version. Raises
    RouteMalformed on invalid JSON, a non-object payload, a foreign
    ``schema_version``, missing keys, or out-of-grammar map_id/version.
    """
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise RouteMalformed("sidecar is not valid JSON: %s" % exc)
    if not isinstance(data, dict):
        raise RouteMalformed("sidecar must be a JSON object")
    schema = data.get("schema_version")
    if isinstance(schema, bool) or not isinstance(schema, int) \
            or schema != SIDE_CAR_SCHEMA_VERSION:
        raise RouteMalformed(
            "unsupported sidecar schema_version %r (want %d)"
            % (schema, SIDE_CAR_SCHEMA_VERSION))
    for key in ("map_id", "map_version"):
        if key not in data:
            raise RouteMalformed("sidecar missing key %r" % key)
    _validate_binding(data["map_id"], data["map_version"])
    return data["map_id"], data["map_version"]


class RouteStore:
    """Reads ``<routes_dir>/<route_id>.txt`` route files and their
    ``<route_id>.route.json`` map binding sidecars."""

    def __init__(self, routes_dir):
        self.routes_dir = Path(routes_dir)

    def _sidecar_path(self, route_id) -> Path:
        return self.routes_dir / (route_id + SIDE_CAR_SUFFIX)

    def _load_binding(self, route_id) -> Tuple[str, str]:
        """``(map_id, map_version)`` from the sidecar; ``("", "")`` when
        the sidecar is absent. Raises RouteMalformed on a bad sidecar."""
        sidecar = self._sidecar_path(route_id)
        if not sidecar.is_file():
            return "", ""
        return parse_route_sidecar(sidecar.read_text(encoding="utf-8"))

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
        map_id, map_version = self._load_binding(route_id)
        return RouteInfo(
            route_id=route_id,
            path=str(path),
            frame_id=header.get("frame_id", ""),
            map_id=map_id,
            map_version=map_version,
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
                map_id, map_version = self._load_binding(entry.stem)
            except (RouteMalformed, OSError, UnicodeDecodeError):
                continue
            out.append(RouteInfo(
                route_id=entry.stem,
                path=str(entry),
                frame_id=header.get("frame_id", ""),
                map_id=map_id,
                map_version=map_version,
                created_at=_iso_utc(entry.stat().st_mtime),
                num_points=len(points),
            ))
        return out

    def bind(self, route_id, map_id, map_version="") -> RouteInfo:
        """Atomically write the route's map binding sidecar.

        The route file must exist and parse. ``map_id=""`` unbinds: an
        absent sidecar is the canonical unbound state, so the sidecar is
        removed. The write goes through a temp file + ``os.replace`` so
        a reader never observes a partial sidecar.
        """
        path = self._resolve(route_id)
        # Fail closed: never bind a route file that does not parse.
        parse_route_file(path.read_text(encoding="utf-8"))
        sidecar = self._sidecar_path(route_id)
        if not map_id:
            if sidecar.is_file():
                sidecar.unlink()
            return self.load(route_id)
        _validate_binding(map_id, map_version)
        payload = {
            "schema_version": SIDE_CAR_SCHEMA_VERSION,
            "map_id": map_id,
            "map_version": map_version or "",
        }
        tmp = sidecar.with_name(
            ".%s.tmp-%s" % (sidecar.name, uuid.uuid4().hex))
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(payload, f, indent=2, sort_keys=True)
                f.write("\n")
            os.replace(tmp, sidecar)
        except BaseException:
            if tmp.exists():
                tmp.unlink()
            raise
        return self.load(route_id)
