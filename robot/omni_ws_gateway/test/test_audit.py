import os
import sys
import tempfile
import time
import unittest

sys.path.insert(
    0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from omni_ws_gateway import audit  # noqa: E402


class AuditLogTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.log = audit.AuditLog(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _today(self) -> str:
        return self.log._day_stamp()

    def test_records_jsonl_line(self):
        self.log.record("login_ok", user="alice", role="operator",
                        peer="10.0.0.5:51234")
        lines = self.log.lines_for(self._today())
        self.assertEqual(1, len(lines))
        entry = lines[0]
        self.assertEqual("login_ok", entry["event"])
        self.assertEqual("alice", entry["user"])
        self.assertEqual("operator", entry["role"])
        self.assertEqual("10.0.0.5:51234", entry["peer"])
        self.assertIn("ts", entry)

    def test_omits_none_fields(self):
        self.log.record("gateway_start", detail={"listen": "0.0.0.0:8765"})
        entry = self.log.lines_for(self._today())[0]
        self.assertNotIn("user", entry)
        self.assertNotIn("op", entry)
        self.assertEqual({"listen": "0.0.0.0:8765"}, entry["detail"])

    def test_denied_op_records_reason(self):
        self.log.record("client_op", user="bob", role="viewer",
                        op="publish", topic="/omni/cmd_vel/teleop",
                        allowed=False, reason="op 'publish' not allowed")
        entry = self.log.lines_for(self._today())[0]
        self.assertFalse(entry["allowed"])
        self.assertEqual("op 'publish' not allowed", entry["reason"])

    def test_never_raises_on_bad_directory(self):
        # Simulate the dir disappearing under a running gateway.
        os.rmdir(self.log.directory)
        try:
            self.log.record("should_not_raise", user="x")
        except Exception as exc:  # pragma: no cover - must not happen
            self.fail(f"record() raised {exc!r}")

    def test_old_files_trimmed(self):
        old = os.path.join(self.log.directory, "audit-20200101.jsonl")
        with open(old, "w", encoding="utf-8") as fh:
            fh.write('{"old": true}\n')
        old_ts = time.time() - 40 * 86400
        os.utime(old, (old_ts, old_ts))
        audit.AuditLog(self._tmp.name)  # constructor trims by mtime
        self.assertFalse(os.path.exists(old))

    def test_recent_files_kept(self):
        recent = os.path.join(self.log.directory, "audit-20260801.jsonl")
        with open(recent, "w", encoding="utf-8") as fh:
            fh.write('{"recent": true}\n')
        # keep it fresh so it is inside the retention window
        now = time.time()
        os.utime(recent, (now, now))
        audit.AuditLog(self._tmp.name)
        self.assertTrue(os.path.exists(recent))

    def test_rotation_on_overflow(self):
        # Force the day file over MAX_BYTES_PER_DAY, then record again.
        stamp = self._today()
        path = self.log._path_for(stamp)
        big = "x" * (audit.MAX_BYTES_PER_DAY + 1)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(big)
        self.log.record("after_overflow")
        self.assertTrue(os.path.exists(path + ".1"))
        # the new day file starts fresh with just our line
        lines = self.log.lines_for(stamp)
        self.assertEqual(1, len(lines))
        self.assertEqual("after_overflow", lines[0]["event"])

    def test_no_rotation_under_limit(self):
        self.log.record("small")
        self.assertFalse(os.path.exists(self.log._path_for(self._today())
                                        + ".1"))


if __name__ == "__main__":
    unittest.main()
