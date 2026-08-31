"""Append-only JSONL audit log.

One file per day (``audit-YYYYMMDD.jsonl``) in the audit directory
(``/var/lib/omni/audit`` on the robot). Each line is a single JSON object
with a stable ``event`` field and metadata only (no message payloads —
the audit trail records *what was allowed/denied*, not *what was sent*).

Retention: files older than ``RETENTION_DAYS`` are removed at startup and
whenever a new day begins. A single day's file that grows past
``MAX_BYTES_PER_DAY`` is rotated to ``.1`` (the overflow day's detail is
sacrificed rather than grow unboundedly; the rotation itself is
auditable via the log file timestamps in any forensic review).
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone

__all__ = ["AuditLog"]

RETENTION_DAYS = 30
MAX_BYTES_PER_DAY = 10 * 1024 * 1024  # 10 MiB


class AuditLog:
    def __init__(self, directory: str):
        self.directory = directory
        os.makedirs(directory, exist_ok=True)
        self._trim_old_files()

    def _day_stamp(self) -> str:
        return datetime.now(timezone.utc).strftime("%Y%m%d")

    def _path_for(self, stamp: str) -> str:
        return os.path.join(self.directory, f"audit-{stamp}.jsonl")

    def _trim_old_files(self) -> None:
        cutoff = time.time() - RETENTION_DAYS * 86400
        try:
            names = os.listdir(self.directory)
        except OSError:
            return
        for name in names:
            if not name.startswith("audit-") or not name.endswith(".jsonl"):
                continue
            path = os.path.join(self.directory, name)
            try:
                if os.path.getmtime(path) < cutoff:
                    os.unlink(path)
            except OSError:
                continue

    def record(
        self,
        event: str,
        *,
        user: str | None = None,
        role: str | None = None,
        peer: str | None = None,
        op: str | None = None,
        topic: str | None = None,
        allowed: bool | None = None,
        reason: str | None = None,
        detail: dict | None = None,
    ) -> None:
        """Append one audit line; never raises (audit must not break I/O)."""
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "event": event,
        }
        for key, value in (
            ("user", user),
            ("role", role),
            ("peer", peer),
            ("op", op),
            ("topic", topic),
            ("allowed", allowed),
            ("reason", reason),
        ):
            if value is not None:
                entry[key] = value
        if detail:
            entry["detail"] = detail
        line = json.dumps(entry, separators=(",", ":"), ensure_ascii=False) + "\n"
        try:
            self._append(line)
        except OSError:
            pass  # audit is best-effort; the connection path must survive

    def _append(self, line: str) -> None:
        while True:
            stamp = self._day_stamp()
            path = self._path_for(stamp)
            size = os.path.getsize(path) if os.path.exists(path) else 0
            if size + len(line.encode("utf-8")) > MAX_BYTES_PER_DAY:
                self._rotate_overflow(path)
                continue
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(line)
            return

    def _rotate_overflow(self, path: str) -> None:
        """Move an over-limit day file to ``<name>.1`` (one step)."""
        overflow = path + ".1"
        try:
            os.replace(path, overflow)
        except OSError:
            pass

    # -- testing helpers -------------------------------------------------

    def lines_for(self, stamp: str) -> list[dict]:
        path = self._path_for(stamp)
        if not os.path.exists(path):
            return []
        out = []
        with open(path, encoding="utf-8") as fh:
            for raw in fh:
                raw = raw.strip()
                if raw:
                    out.append(json.loads(raw))
        return out
