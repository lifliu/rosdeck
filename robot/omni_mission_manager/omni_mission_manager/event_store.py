"""SQLite persistence for missions and events (V1).

Pure Python (sqlite3 stdlib, no ROS imports) so the core is unit-testable
off the robot. Timestamps are ISO-8601 UTC strings supplied by the caller
(the node uses the wall clock; tests use fixed values).

All access happens on the rclpy executor thread except
`append_checkpoint_result`, which is also called from the checkpoint worker
thread; the node serializes both with one lock (the sqlite3 connection is
NOT shared between threads otherwise).

Schema:
  missions            one row per dispatched mission (terminal rows are kept)
  mission_events      append-only per-mission event stream (PK
                      (mission_id, sequence); sequence starts at 1)
  idempotency         (request_id, sequence) -> mission_id
  checkpoint_results  durable evidence history per mission (Phase 3; the
                      live view is /omni/mission/checkpoint_results)
"""

import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import constants as C

SCHEMA = """
CREATE TABLE IF NOT EXISTS missions (
  mission_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  route_id TEXT NOT NULL,
  map_id TEXT NOT NULL DEFAULT '',
  map_version TEXT NOT NULL DEFAULT '',
  state INTEGER NOT NULL,
  progress REAL NOT NULL DEFAULT 0.0,
  reason_code INTEGER NOT NULL DEFAULT 0,
  reason_text TEXT NOT NULL DEFAULT '',
  status_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_missions_state ON missions(state);
CREATE TABLE IF NOT EXISTS mission_events (
  mission_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event INTEGER NOT NULL,
  mission_state INTEGER NOT NULL,
  progress REAL NOT NULL,
  reason_code INTEGER NOT NULL DEFAULT 0,
  reason_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (mission_id, sequence)
);
CREATE TABLE IF NOT EXISTS idempotency (
  request_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  mission_id TEXT NOT NULL,
  PRIMARY KEY (request_id, sequence)
);
CREATE TABLE IF NOT EXISTS checkpoint_results (
  mission_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,          -- per-mission record order, from 1
  checkpoint_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  status INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  artifact_path TEXT NOT NULL DEFAULT '',
  result_json TEXT NOT NULL DEFAULT '',
  pose_x REAL NOT NULL DEFAULT 0.0,
  pose_y REAL NOT NULL DEFAULT 0.0,
  pose_z REAL NOT NULL DEFAULT 0.0,
  pose_yaw REAL NOT NULL DEFAULT 0.0,
  map_id TEXT NOT NULL DEFAULT '',
  map_version TEXT NOT NULL DEFAULT '',
  software_version TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (mission_id, sequence)
);
"""


class EventStore:
    def __init__(self, db_path):
        self.db_path = str(db_path)
        if self.db_path != ":memory:":
            Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        # check_same_thread=False: the node also appends checkpoint records
        # from the checkpoint worker thread. All callers (executor thread
        # and worker thread) hold the node's store lock, which serializes
        # the connection.
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode = WAL")
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    # --- missions ---

    def begin_mission(self, mission_id, request_id, sequence, route_id,
                      map_id, map_version, now):
        """Insert a fresh PENDING mission plus its idempotency row.

        Caller must have verified the (request_id, sequence) key is free;
        an IntegrityError here means a race the caller should treat as a
        duplicate.
        """
        self._conn.execute(
            "INSERT INTO missions (mission_id, request_id, sequence, "
            "route_id, map_id, map_version, state, progress, reason_code, "
            "reason_text, status_text, created_at, updated_at, "
            "terminated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0.0, 0, '', '', "
            "?, ?, NULL)",
            (mission_id, request_id, int(sequence), route_id,
             map_id or "", map_version or "", C.MISSION_PENDING, now, now))
        self._conn.execute(
            "INSERT INTO idempotency (request_id, sequence, mission_id) "
            "VALUES (?, ?, ?)",
            (request_id, int(sequence), mission_id))
        self._conn.commit()

    def get_all_missions(self) -> List[Dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT * FROM missions ORDER BY created_at, mission_id"
        ).fetchall()
        return [dict(r) for r in rows]

    def get_mission(self, mission_id) -> Optional[Dict[str, Any]]:
        row = self._conn.execute(
            "SELECT * FROM missions WHERE mission_id = ?", (mission_id,)
        ).fetchone()
        return dict(row) if row is not None else None

    def mission_exists(self, mission_id) -> bool:
        row = self._conn.execute(
            "SELECT 1 FROM missions WHERE mission_id = ?", (mission_id,)
        ).fetchone()
        return row is not None

    def list_active_missions(self) -> List[Dict[str, Any]]:
        ph = ",".join("?" * len(C.ACTIVE_STATES))
        rows = self._conn.execute(
            "SELECT * FROM missions WHERE state IN (%s)" % ph,
            C.ACTIVE_STATES).fetchall()
        return [dict(r) for r in rows]

    def update_mission(self, mission_id, now, *, state=None, progress=None,
                       reason_code=None, reason_text=None, status_text=None,
                       terminated=False):
        sets = []
        params = []
        if state is not None:
            sets.append("state = ?")
            params.append(int(state))
        if progress is not None:
            sets.append("progress = ?")
            params.append(float(progress))
        if reason_code is not None:
            sets.append("reason_code = ?")
            params.append(int(reason_code))
        if reason_text is not None:
            sets.append("reason_text = ?")
            params.append(reason_text)
        if status_text is not None:
            sets.append("status_text = ?")
            params.append(status_text)
        sets.append("updated_at = ?")
        params.append(now)
        if terminated:
            sets.append("terminated_at = ?")
            params.append(now)
        params.append(mission_id)
        self._conn.execute(
            "UPDATE missions SET " + ", ".join(sets) +
            " WHERE mission_id = ?", params)
        self._conn.commit()

    def delete_mission(self, mission_id):
        """Remove a mission that never started (dispatch aborted before
        the DISPATCHED event). Frees its (request_id, sequence) key so the
        App can retry."""
        self._conn.execute(
            "DELETE FROM missions WHERE mission_id = ?", (mission_id,))
        self._conn.execute(
            "DELETE FROM mission_events WHERE mission_id = ?", (mission_id,))
        self._conn.execute(
            "DELETE FROM idempotency WHERE mission_id = ?", (mission_id,))
        self._conn.commit()

    # --- events ---

    def append_event(self, mission_id, sequence, event, mission_state,
                     progress, reason_code, reason_text, now):
        self._conn.execute(
            "INSERT INTO mission_events (mission_id, sequence, event, "
            "mission_state, progress, reason_code, reason_text, "
            "created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (mission_id, int(sequence), int(event), int(mission_state),
             float(progress), int(reason_code), reason_text, now))
        self._conn.commit()

    def event_count(self, mission_id) -> int:
        row = self._conn.execute(
            "SELECT COUNT(*) AS n FROM mission_events WHERE mission_id = ?",
            (mission_id,)).fetchone()
        return int(row["n"])

    # --- idempotency ---

    def lookup_mission_id(self, request_id, sequence) -> Optional[str]:
        row = self._conn.execute(
            "SELECT mission_id FROM idempotency WHERE request_id = ? AND "
            "sequence = ?", (request_id, int(sequence))).fetchone()
        return row["mission_id"] if row is not None else None

    def max_sequence_for_request(self, request_id) -> int:
        row = self._conn.execute(
            "SELECT COALESCE(MAX(sequence), 0) AS s FROM idempotency "
            "WHERE request_id = ?", (request_id,)).fetchone()
        return int(row["s"])

    # --- checkpoint results (Phase 3 evidence) ---

    def append_checkpoint_result(self, mission_id, checkpoint_id,
                                 action_type, status, attempts, reason,
                                 artifact_path, result_json, pose,
                                 map_id, map_version, software_version, now):
        """Append one evidence record. `pose` is (x, y, z, yaw) or None.

        Callers must hold the node's store lock (executor thread or the
        checkpoint worker thread).
        """
        row = self._conn.execute(
            "SELECT COALESCE(MAX(sequence), 0) AS s FROM "
            "checkpoint_results WHERE mission_id = ?",
            (mission_id,)).fetchone()
        sequence = int(row["s"]) + 1
        x, y, z, yaw = (pose if pose is not None else (0.0, 0.0, 0.0, 0.0))
        self._conn.execute(
            "INSERT INTO checkpoint_results (mission_id, sequence, "
            "checkpoint_id, action_type, status, attempts, reason, "
            "artifact_path, result_json, pose_x, pose_y, pose_z, pose_yaw, "
            "map_id, map_version, software_version, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (mission_id, sequence, checkpoint_id, action_type, int(status),
             int(attempts), reason, artifact_path, result_json,
             float(x), float(y), float(z), float(yaw), map_id or "",
             map_version or "", software_version or "", now))
        self._conn.commit()

    def get_checkpoint_results(self, mission_id) -> List[Dict[str, Any]]:
        """All records for a mission in time order ([] if none)."""
        rows = self._conn.execute(
            "SELECT * FROM checkpoint_results WHERE mission_id = ? "
            "ORDER BY sequence", (mission_id,)).fetchall()
        return [dict(r) for r in rows]

    def close(self):
        try:
            self._conn.commit()
        finally:
            self._conn.close()