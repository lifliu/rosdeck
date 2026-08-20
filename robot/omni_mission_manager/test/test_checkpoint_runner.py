"""CheckpointRunner tests — deterministic via injected clock/executors.

Pure Python, no ROS required.

Run: python3 -m unittest discover -s test -v
"""

import os
import sys
import unittest

sys.path.insert(
    0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from omni_mission_manager.checkpoints import (  # noqa: E402
    ACTION_DWELL,
    ACTION_PHOTO,
    ACTION_RECORD,
    ACTION_RECOGNIZE,
    ActionSpec,
    CheckpointSpec,
)
from omni_mission_manager.checkpoint_runner import (  # noqa: E402
    CaptureOutcome,
    CheckpointRunner,
    STATUS_FAILED,
    STATUS_SKIPPED,
    STATUS_SUCCEEDED,
)


class Clock:
    def __init__(self):
        self.t = 0.0

    def now(self):
        return self.t

    def sleep(self, chunk):
        self.t += chunk


class Execs:
    """Fake perception executors: scripted results, recorded calls."""

    def __init__(self):
        self.photo_results = []
        self.record_results = []
        self.recognize_results = []
        self.photo_calls = []
        self.record_calls = []
        self.recognize_calls = []

    def photo(self, count):
        self.photo_calls.append(count)
        return self.photo_results.pop(0)

    def record(self, seconds):
        self.record_calls.append(seconds)
        return self.record_results.pop(0)

    def recognize(self, target):
        self.recognize_calls.append(target)
        return self.recognize_results.pop(0)


def ok(path="", rjson=""):
    return CaptureOutcome(ok=True, artifact_path=path, result_json=rjson)


def fail(reason="camera down"):
    return CaptureOutcome(ok=False, reason=reason)


def spec(actions, on_failure="fail", attempts=2, cp_id="a"):
    return CheckpointSpec(id=cp_id, point_index=0, on_failure=on_failure,
                          attempts=attempts, actions=tuple(actions))


def runner(ex, *, clock=None, paused=None, abort=None, on_record=None,
           poll=0.1):
    clock = clock or Clock()
    return (CheckpointRunner(
                ex, is_paused=paused, should_abort=abort,
                on_record=on_record, sleep=clock.sleep, now=clock.now,
                poll_sec=poll),
            clock)


class DwellTests(unittest.TestCase):
    def test_dwell_consumes_time_no_record(self):
        ex = Execs()
        r, clock = runner(ex)
        out = r.run(spec([ActionSpec(ACTION_DWELL, value=1000)]))
        self.assertEqual(out.records, [])
        self.assertFalse(out.failed)
        self.assertFalse(out.aborted)
        self.assertAlmostEqual(clock.t, 1.0)

    def test_dwell_clamps_final_chunk(self):
        ex = Execs()
        r, clock = runner(ex)
        r.run(spec([ActionSpec(ACTION_DWELL, value=250)]))
        self.assertAlmostEqual(clock.t, 0.25)

    def test_pause_does_not_consume_dwell(self):
        ex = Execs()
        clock = Clock()
        r, _ = runner(ex, clock=clock, paused=lambda: clock.t < 0.2)
        out = r.run(spec([ActionSpec(ACTION_DWELL, value=1000)]))
        self.assertEqual(out.records, [])
        # 0.2 s idle while paused + 1.0 s of dwell.
        self.assertAlmostEqual(clock.t, 1.2)

    def test_abort_during_dwell_skips_remaining(self):
        ex = Execs()
        clock = Clock()
        r, _ = runner(ex, clock=clock, abort=lambda: clock.t >= 0.5)
        out = r.run(spec([ActionSpec(ACTION_DWELL, value=1000),
                         ActionSpec(ACTION_PHOTO, value=1)]))
        self.assertTrue(out.aborted)
        self.assertEqual(len(out.records), 1)
        rec = out.records[0]
        self.assertEqual(rec.action_type, ACTION_PHOTO)
        self.assertEqual(rec.status, STATUS_SKIPPED)
        self.assertEqual(rec.attempts, 0)
        self.assertEqual(rec.reason, "mission interrupted")
        self.assertAlmostEqual(clock.t, 0.5)
        self.assertEqual(ex.photo_calls, [])


class EvidenceTests(unittest.TestCase):
    def test_success_first_try(self):
        ex = Execs()
        ex.photo_results = [ok("/tmp/p.jpg")]
        r, _ = runner(ex)
        out = r.run(spec([ActionSpec(ACTION_PHOTO, value=3)], attempts=2))
        self.assertEqual(len(out.records), 1)
        rec = out.records[0]
        self.assertEqual(rec.status, STATUS_SUCCEEDED)
        self.assertEqual(rec.attempts, 1)
        self.assertEqual(rec.artifact_path, "/tmp/p.jpg")
        self.assertEqual(ex.photo_calls, [3])  # int(count)

    def test_retry_then_success(self):
        ex = Execs()
        ex.photo_results = [fail("busy"), ok("/tmp/p.jpg")]
        r, _ = runner(ex)
        out = r.run(spec([ActionSpec(ACTION_PHOTO, value=1)], attempts=2))
        self.assertFalse(out.failed)
        rec = out.records[0]
        self.assertEqual(rec.status, STATUS_SUCCEEDED)
        self.assertEqual(rec.attempts, 2)

    def test_retries_exhausted_fail_policy(self):
        ex = Execs()
        ex.photo_results = [fail("cam busy"), fail("cam gone")]
        r, _ = runner(ex)
        out = r.run(spec(
            [ActionSpec(ACTION_PHOTO, value=1),
             ActionSpec(ACTION_RECOGNIZE, target="meter")], attempts=2))
        self.assertTrue(out.failed)
        self.assertEqual(out.fail_reason,
                         "checkpoint action photo failed: cam gone")
        rec = out.records[0]
        self.assertEqual(rec.status, STATUS_FAILED)
        self.assertEqual(rec.attempts, 2)
        # fail policy stops the checkpoint: recognize never ran.
        self.assertEqual(ex.recognize_calls, [])

    def test_skip_policy_continues_after_failure(self):
        ex = Execs()
        ex.photo_results = [fail("cam busy")]
        ex.recognize_results = [ok(rjson="{}")]
        r, _ = runner(ex)
        out = r.run(spec(
            [ActionSpec(ACTION_PHOTO, value=1),
             ActionSpec(ACTION_RECOGNIZE, target="meter")],
            on_failure="skip", attempts=1))
        self.assertFalse(out.failed)
        self.assertEqual([(r.status, r.action_type) for r in out.records],
                         [(STATUS_FAILED, ACTION_PHOTO),
                          (STATUS_SUCCEEDED, ACTION_RECOGNIZE)])

    def test_abort_mid_evidence(self):
        ex = Execs()
        ex.photo_results = [fail(), fail()]  # third call must never happen
        r, _ = runner(ex, abort=lambda: len(ex.photo_calls) >= 2)
        out = r.run(spec([ActionSpec(ACTION_PHOTO, value=1)], attempts=3))
        self.assertTrue(out.aborted)
        rec = out.records[0]
        self.assertEqual(rec.status, STATUS_SKIPPED)
        self.assertEqual(rec.attempts, 2)
        self.assertEqual(rec.reason, "mission interrupted")
        self.assertEqual(len(ex.photo_calls), 2)

    def test_abort_before_anything_skips_all(self):
        ex = Execs()
        r, _ = runner(ex, abort=lambda: True)
        out = r.run(spec([ActionSpec(ACTION_DWELL, value=1000),
                         ActionSpec(ACTION_PHOTO, value=1)]))
        self.assertTrue(out.aborted)
        self.assertEqual([(r.action_type, r.status, r.attempts)
                          for r in out.records],
                         [(ACTION_DWELL, STATUS_SKIPPED, 0),
                          (ACTION_PHOTO, STATUS_SKIPPED, 0)])
        self.assertEqual(ex.photo_calls, [])

    def test_pause_between_retries_does_not_consume_attempts(self):
        ex = Execs()
        ex.photo_results = [fail(), ok("/tmp/p.jpg")]
        clock = Clock()
        r, _ = runner(ex, clock=clock, paused=lambda: clock.t < 0.3)
        out = r.run(spec([ActionSpec(ACTION_PHOTO, value=1)], attempts=2))
        rec = out.records[0]
        self.assertEqual(rec.status, STATUS_SUCCEEDED)
        self.assertEqual(rec.attempts, 2)
        self.assertAlmostEqual(clock.t, 0.3)  # only the pause wait


class MiscTests(unittest.TestCase):
    def test_record_seconds_not_forced_to_int(self):
        ex = Execs()
        ex.record_results = [ok("/tmp/clip.mp4")]
        r, _ = runner(ex)
        r.run(spec([ActionSpec(ACTION_RECORD, value=2.5)]))
        self.assertEqual(ex.record_calls, [2.5])

    def test_on_record_called_per_record(self):
        ex = Execs()
        ex.photo_results = [ok("/tmp/p.jpg")]
        seen = []
        r, _ = runner(ex, on_record=seen.append)
        out = r.run(spec([ActionSpec(ACTION_PHOTO, value=1)]))
        self.assertEqual(seen, out.records)

    def test_dwell_then_photo_full_sequence(self):
        ex = Execs()
        ex.photo_results = [ok("/tmp/p.jpg")]
        r, clock = runner(ex)
        out = r.run(spec([ActionSpec(ACTION_DWELL, value=500),
                         ActionSpec(ACTION_PHOTO, value=2)]))
        self.assertFalse(out.failed)
        self.assertEqual(len(out.records), 1)
        self.assertEqual(out.records[0].status, STATUS_SUCCEEDED)
        self.assertAlmostEqual(clock.t, 0.5)


if __name__ == "__main__":
    unittest.main()
