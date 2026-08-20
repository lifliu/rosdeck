"""wait_with_cancel tests — deterministic via injected clock.

Pure Python, no ROS required.

Run: python3 -m unittest discover -s test -v
"""

import os
import sys
import unittest

sys.path.insert(
    0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from omni_mission_manager.cancel_wait import wait_with_cancel  # noqa: E402


class Clock:
    def __init__(self):
        self.t = 0.0

    def now(self):
        return self.t

    def sleep(self, chunk):
        self.t += chunk


def run(done, cancel, timeout, *, clock=None, poll=0.1):
    clock = clock or Clock()
    return (wait_with_cancel(
                done, cancel, timeout,
                poll_sec=poll, sleep=clock.sleep, now=clock.now),
            clock.t)


class WaitTests(unittest.TestCase):
    def test_done_immediately(self):
        ok, t = run(lambda: True, lambda: False, None)
        self.assertTrue(ok)
        self.assertEqual(t, 0.0)

    def test_polls_until_done(self):
        calls = {"n": 0}

        def done():
            calls["n"] += 1
            return calls["n"] >= 2

        ok, t = run(done, lambda: False, None)
        self.assertTrue(ok)
        self.assertEqual(t, 0.1)  # one poll, then done on the second check

    def test_done_wins_over_cancel(self):
        # done() is checked before cancel each loop iteration.
        ok, _t = run(lambda: True, lambda: True, None)
        self.assertTrue(ok)

    def test_deadline_returns_false(self):
        ok, t = run(lambda: False, lambda: False, 0.3)
        self.assertFalse(ok)
        self.assertAlmostEqual(t, 0.3)

    def test_tight_deadline_clamps_final_sleep(self):
        # poll 0.1, deadline 0.15: sleeps 0.1 then 0.05, not 0.2.
        ok, t = run(lambda: False, lambda: False, 0.15)
        self.assertFalse(ok)
        self.assertAlmostEqual(t, 0.15)

    def test_cancel_third_poll(self):
        calls = {"n": 0}

        def cancel():
            calls["n"] += 1
            return calls["n"] >= 3

        ok, t = run(lambda: False, cancel, None)
        self.assertFalse(ok)
        self.assertEqual(t, 0.2)  # cancelled before the third sleep

    def test_cancel_immediately(self):
        ok, t = run(lambda: False, lambda: True, None)
        self.assertFalse(ok)
        self.assertEqual(t, 0.0)

    def test_zero_timeout_means_cancel_only(self):
        calls = {"n": 0}

        def cancel():
            calls["n"] += 1
            return calls["n"] >= 2

        ok, t = run(lambda: False, cancel, 0)
        self.assertFalse(ok)
        self.assertEqual(t, 0.1)

    def test_negative_timeout_means_cancel_only(self):
        # A negative timeout is treated like 0: no deadline.
        calls = {"n": 0}

        def cancel():
            calls["n"] += 1
            return calls["n"] >= 2

        ok, t = run(lambda: False, cancel, -1)
        self.assertFalse(ok)
        self.assertEqual(t, 0.1)

    def test_none_timeout_means_cancel_only(self):
        ok, t = run(lambda: False, lambda: True, None)
        self.assertFalse(ok)
        self.assertEqual(t, 0.0)

    def test_cancel_not_callable_raises_typeerror(self):
        with self.assertRaises(TypeError):
            wait_with_cancel(lambda: False, True, 1.0)  # bool, not callable

    def test_done_after_some_polls_stops_early(self):
        calls = {"n": 0}

        def done():
            calls["n"] += 1
            return calls["n"] >= 4

        ok, t = run(done, lambda: False, 5.0, poll=0.1)
        self.assertTrue(ok)
        self.assertAlmostEqual(t, 0.3)  # never hits the 5 s deadline


if __name__ == "__main__":
    unittest.main()
