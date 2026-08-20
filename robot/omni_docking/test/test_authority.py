"""authority tests — pure Python, no ROS required.

Run: python3 -m unittest discover -s test -v
"""

import os
import sys
import unittest

sys.path.insert(
    0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from omni_docking import authority, constants  # noqa: E402


class MakeClientIdTest(unittest.TestCase):
    def test_plain_uuid(self):
        cid = authority.make_client_id("550e8400-e29b-41d4-a716-446655440000")
        self.assertEqual(cid, "docking-550e8400-e29b-41d4-a716-446655440000")
        self.assertLessEqual(len(cid), 64)

    def test_invalid_chars_dropped(self):
        cid = authority.make_client_id("abc!def g.h")
        self.assertEqual(cid, "docking-abcdefgh")

    def test_too_long_truncated(self):
        cid = authority.make_client_id("a" * 200)
        self.assertEqual(len(cid), 64)
        self.assertEqual(cid, "docking-" + "a" * 56)

    def test_empty_rejected(self):
        for bad in ("", "   ", "!!!", None):
            with self.assertRaises(ValueError):
                authority.make_client_id(bad)

    def test_rtd_prefix_stays_valid(self):
        # mission-manager return-chain convention
        cid = authority.make_client_id("rtd-" + "b" * 50)
        self.assertTrue(authority.is_return_chain(cid))
        self.assertLessEqual(len(cid), 64)


class CommandTest(unittest.TestCase):
    def test_render(self):
        for action in (constants.ACTION_ACQUIRE, constants.ACTION_RELEASE,
                       constants.ACTION_HEARTBEAT):
            self.assertEqual(
                authority.command(action, "docking-x1"),
                "{}:docking-x1".format(action))

    def test_bad_action(self):
        with self.assertRaises(ValueError):
            authority.command("steal", "docking-x1")

    def test_bad_client_id(self):
        with self.assertRaises(ValueError):
            authority.command(constants.ACTION_ACQUIRE, "has space")


class ParseStatusTest(unittest.TestCase):
    def test_acquired(self):
        self.assertEqual(authority.parse_status("acquired:docking-r1"),
                         ("acquired", "docking-r1"))
        self.assertEqual(authority.parse_status("acquired:mission-m9"),
                         ("acquired", "mission-m9"))

    def test_error(self):
        self.assertEqual(authority.parse_status("error:estop latched"),
                         ("error", "estop latched"))

    def test_unknown(self):
        self.assertEqual(authority.parse_status(""), ("unknown", ""))
        self.assertEqual(authority.parse_status(None), ("unknown", ""))
        self.assertEqual(authority.parse_status("garbage"), ("unknown", ""))
        self.assertEqual(authority.parse_status("acquired:"),
                         ("unknown", ""))

    def test_holding(self):
        self.assertTrue(authority.holding("acquired:docking-r1", "docking-r1"))
        self.assertFalse(
            authority.holding("acquired:mission-m9", "docking-r1"))
        self.assertFalse(authority.holding("error:none", "docking-r1"))
        self.assertFalse(authority.holding("", "docking-r1"))


class ReturnChainTest(unittest.TestCase):
    def test_prefix(self):
        self.assertTrue(
            authority.is_return_chain("docking-rtd-abc123"))
        self.assertFalse(authority.is_return_chain("docking-abc123"))


if __name__ == "__main__":
    unittest.main()
