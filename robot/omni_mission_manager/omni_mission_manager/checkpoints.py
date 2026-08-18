"""Checkpoint sidecar parsing and segment planning (pure, no ROS).

A route may carry a checkpoint sidecar file next to it:

    <route_id>.txt               -> route file (RouteStore format)
    <route_id>.checkpoints.json  -> this file

Sidecar JSON (schema_version 1):

    {
      "schema_version": 1,
      "checkpoints": [
        {
          "id": "cp-01",
          "point_index": 4,
          "on_failure": "fail",          # "fail" (default) | "skip"
          "attempts": 2,                 # 1..3, default 2 (evidence actions)
          "actions": [
            {"type": "dwell", "ms": 1000},
            {"type": "photo", "count": 3},
            {"type": "record", "seconds": 10},
            {"type": "recognize", "target": "meter"}
          ]
        }
      ]
    }

Semantics (see CheckpointResult.msg and the mission manager docs):

* The robot drives to the checkpoint's route point, stops, and runs its
  actions in order: dwell (wait), photo / record / recognize (evidence,
  with retry attempts).
* A dwell is temporal only and produces no evidence record.
* `on_failure` decides what a failed evidence action (after its attempts)
  means for the mission: "fail" -> mission FAILED; "skip" -> a SKIPPED
  record is written and the mission continues.
* Checkpoints are executed in ascending point_index order; ties keep the
  file order.

The sidecar is OPTIONAL. No sidecar -> the route has no checkpoints (the
V1 single-segment behavior). A present but malformed sidecar fails closed:
dispatch is rejected, never silently executed without checkpoints.

This module is pure Python (json + dataclasses) so it is fully unit-testable
without a ROS environment. The node layer wraps it.
"""

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

CHECKPOINT_SIDE_CAR_SUFFIX = ".checkpoints.json"
CHECKPOINT_SCHEMA_VERSION = 1
# RouteStore's route files always end in ".txt" (route_id + ".txt"); the
# sidecar swaps that suffix for the checkpoint one.
ROUTE_FILE_SUFFIX = ".txt"

# Checkpoint id grammar: same as map_id (short, filesystem/log friendly).
CHECKPOINT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")

# Action types. Only the last three produce a CheckpointResult record.
ACTION_DWELL = "dwell"
ACTION_PHOTO = "photo"
ACTION_RECORD = "record"
ACTION_RECOGNIZE = "recognize"
VALID_ACTIONS = (ACTION_DWELL, ACTION_PHOTO, ACTION_RECORD, ACTION_RECOGNIZE)

# Action parameter limits (the provider services validate their side too;
# these keep the sidecar honest at load time).
DWELL_MS_MIN, DWELL_MS_MAX = 100, 60000
DWELL_MS_DEFAULT = 1000
PHOTO_COUNT_MIN, PHOTO_COUNT_MAX = 1, 20
PHOTO_COUNT_DEFAULT = 1
RECORD_SEC_MIN, RECORD_SEC_MAX = 1.0, 600.0
RECORD_SEC_DEFAULT = 5.0
RECOGNIZE_TARGET_MAX = 128
ATTEMPTS_MIN, ATTEMPTS_MAX = 1, 3
ATTEMPTS_DEFAULT = 2
ON_FAILURE_FAIL = "fail"
ON_FAILURE_SKIP = "skip"
VALID_ON_FAILURE = (ON_FAILURE_FAIL, ON_FAILURE_SKIP)


class CheckpointsMalformed(ValueError):
    """The checkpoint sidecar exists but is unusable (fail-closed)."""


@dataclass(frozen=True)
class ActionSpec:
    """One checkpoint action.

    Parameter slots are per-type; only the slot matching `type` is set:
      dwell     -> value = milliseconds
      photo     -> value = frame count
      record    -> value = seconds
      recognize -> target
    """

    type: str
    value: float = 0.0
    target: str = ""


@dataclass(frozen=True)
class CheckpointSpec:
    id: str
    point_index: int
    on_failure: str          # "fail" | "skip"
    attempts: int            # per evidence action
    actions: Tuple[ActionSpec, ...]


@dataclass(frozen=True)
class Segment:
    """One driving leg between two consecutive checkpoint points.

    start_index / end_index are inclusive route-point indices. A zero-length
    segment (start == end) means "run the checkpoint where the robot already
    is" (e.g. a checkpoint at point 0, or two checkpoints on the same
    point). checkpoint_id is the checkpoint executed on arrival, or "" for a
    plain driving leg (always the final one).
    """

    start_index: int
    end_index: int
    checkpoint_id: str


@dataclass(frozen=True)
class CheckpointPlan:
    segments: Tuple[Segment, ...]
    specs: Dict[str, CheckpointSpec] = field(compare=False, default_factory=dict)
    num_points: int = 0


def _fail(message: str):
    raise CheckpointsMalformed(message)


def _as_int(value, name: str, lo: int, hi: int):
    if isinstance(value, bool) or not isinstance(value, (int, float)) \
            or int(value) != value:
        _fail("%s must be an integer" % name)
    ivalue = int(value)
    if ivalue < lo or ivalue > hi:
        _fail("%s must be in [%d, %d], got %d" % (name, lo, hi, ivalue))
    return ivalue


def _as_number(value, name: str, lo: float, hi: float):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail("%s must be a number" % name)
    if not (lo <= float(value) <= hi):
        _fail("%s must be in [%s, %s], got %s" % (name, lo, hi, value))
    return float(value)


def _parse_action(raw, index: int) -> ActionSpec:
    if not isinstance(raw, dict):
        _fail("action[%d] must be an object" % index)
    atype = raw.get("type")
    if atype not in VALID_ACTIONS:
        _fail("action[%d].type must be one of %s, got %r"
              % (index, list(VALID_ACTIONS), atype))
    value = 0.0
    target = ""
    if atype == ACTION_DWELL:
        value = _as_int(raw.get("ms", DWELL_MS_DEFAULT),
                        "action[%d].ms" % index, DWELL_MS_MIN, DWELL_MS_MAX)
    elif atype == ACTION_PHOTO:
        value = _as_int(raw.get("count", PHOTO_COUNT_DEFAULT),
                        "action[%d].count" % index,
                        PHOTO_COUNT_MIN, PHOTO_COUNT_MAX)
    elif atype == ACTION_RECORD:
        value = _as_number(raw.get("seconds", RECORD_SEC_DEFAULT),
                           "action[%d].seconds" % index,
                           RECORD_SEC_MIN, RECORD_SEC_MAX)
    else:  # recognize
        target = raw.get("target", "")
        if not isinstance(target, str) or not (1 <= len(target)
                                               <= RECOGNIZE_TARGET_MAX):
            _fail("action[%d].target must be a non-empty string of at most "
                  "%d chars" % (index, RECOGNIZE_TARGET_MAX))
    return ActionSpec(type=atype, value=value, target=target)


def parse_checkpoint_sidecar(text: str,
                             num_points: int) -> Tuple[CheckpointSpec, ...]:
    """Parse and validate a sidecar document against the route length.

    `num_points` is the route's point count (from RouteInfo); point_index
    values are validated against it here so a stale sidecar can never send
    the robot off the end of its own path.
    """
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        _fail("invalid JSON: %s" % exc)
    if not isinstance(data, dict):
        _fail("top level must be an object")
    if data.get("schema_version") != CHECKPOINT_SCHEMA_VERSION:
        _fail("unsupported schema_version %r (expected %d)"
              % (data.get("schema_version"), CHECKPOINT_SCHEMA_VERSION))
    raw_cps = data.get("checkpoints")
    if not isinstance(raw_cps, list) or not raw_cps:
        _fail("checkpoints must be a non-empty array")

    specs: List[CheckpointSpec] = []
    seen_ids = set()
    for i, raw in enumerate(raw_cps):
        where = "checkpoints[%d]" % i
        if not isinstance(raw, dict):
            _fail("%s must be an object" % where)
        cp_id = raw.get("id")
        if not isinstance(cp_id, str) or not CHECKPOINT_ID_RE.match(cp_id):
            _fail("%s.id must match %s" % (where, CHECKPOINT_ID_RE.pattern))
        if cp_id in seen_ids:
            _fail("%s.id %r is duplicated" % (where, cp_id))
        seen_ids.add(cp_id)

        point_index = _as_int(raw.get("point_index"),
                              "%s.point_index" % where, 0, num_points - 1)
        on_failure = raw.get("on_failure", ON_FAILURE_FAIL)
        if on_failure not in VALID_ON_FAILURE:
            _fail("%s.on_failure must be one of %s, got %r"
                  % (where, list(VALID_ON_FAILURE), on_failure))
        attempts = _as_int(raw.get("attempts", ATTEMPTS_DEFAULT),
                           "%s.attempts" % where, ATTEMPTS_MIN, ATTEMPTS_MAX)

        raw_actions = raw.get("actions")
        if not isinstance(raw_actions, list) or not raw_actions:
            _fail("%s.actions must be a non-empty array" % where)
        actions = tuple(_parse_action(a, j)
                        for j, a in enumerate(raw_actions))

        specs.append(CheckpointSpec(id=cp_id, point_index=point_index,
                                    on_failure=on_failure, attempts=attempts,
                                    actions=actions))
    return tuple(specs)


def plan_segments(num_points: int,
                  checkpoints: Sequence[CheckpointSpec]) -> CheckpointPlan:
    """Split a route at its checkpoints into driving segments.

    Order is by ascending point_index (ties keep input order). Each segment
    ends at its checkpoint's point (or at the last route point for the final
    leg). A checkpoint at point 0, or on the same point as the previous
    checkpoint, becomes a zero-length segment that runs the checkpoint where
    the robot already is.
    """
    if num_points < 2:
        _fail("route must have at least 2 points")
    ordered = sorted(checkpoints, key=lambda c: (c.point_index,))

    legs: List[Segment] = []
    pos = 0
    for cp in ordered:
        # cp.point_index > pos  -> drive (pos, cp.point_index], run cp there
        # cp.point_index == pos -> zero-length leg, run cp in place
        legs.append(Segment(start_index=pos, end_index=cp.point_index,
                            checkpoint_id=cp.id))
        pos = cp.point_index
    if pos < num_points - 1:
        legs.append(Segment(start_index=pos, end_index=num_points - 1,
                            checkpoint_id=""))
    return CheckpointPlan(segments=tuple(legs),
                          specs={cp.id: cp for cp in ordered},
                          num_points=num_points)


def segment_progress(seg: Segment, feedback_progress: float,
                     num_points: int) -> float:
    """Map a segment's local progress (0..1) to overall route progress."""
    span = num_points - 1
    if span <= 0:
        return 1.0
    local = 0.0 if feedback_progress < 0 else (1.0 if feedback_progress > 1
                                               else feedback_progress)
    return (seg.start_index + local * (seg.end_index - seg.start_index)) / span


def checkpoint_progress(seg: Segment, num_points: int) -> float:
    """Overall progress while the robot sits at `seg` running its actions."""
    span = num_points - 1
    if span <= 0:
        return 1.0
    return seg.end_index / span


def sidecar_path(route_path) -> Path:
    """Sidecar path for a route file path (<route_id>.checkpoints.json)."""
    route_path = Path(route_path)
    name = route_path.name
    stem = (name[:-len(ROUTE_FILE_SUFFIX)]
            if name.endswith(ROUTE_FILE_SUFFIX) else name)
    return route_path.parent / (stem + CHECKPOINT_SIDE_CAR_SUFFIX)


class CheckpointStore:
    """Load a route's checkpoint sidecar through its RouteStore.

    No sidecar -> empty tuple (the V1 single-segment behavior). A present
    but malformed sidecar raises CheckpointsMalformed (fail-closed).
    """

    def __init__(self, route_store):
        self._routes = route_store

    def load(self, route_id: str) -> Tuple[CheckpointSpec, ...]:
        route = self._routes.load(route_id)
        sidecar = sidecar_path(route.path)
        if not sidecar.is_file():
            return ()
        return parse_checkpoint_sidecar(sidecar.read_text(encoding="utf-8"),
                                        route.num_points)