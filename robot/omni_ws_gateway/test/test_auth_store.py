import os
import sys
import tempfile
import time
import unittest

sys.path.insert(
    0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from omni_ws_gateway.auth_store import (  # noqa: E402
    FAIL_LIMIT,
    RateLimiter,
    UserStore,
    generate_token,
    hash_token,
)


class UserStoreTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self._tmp.name, "users.json")
        self.store = UserStore(self.path)

    def tearDown(self):
        self._tmp.cleanup()

    def test_starts_empty(self):
        self.assertEqual([], self.store.list_users())
        self.assertFalse(self.store.verify("anything").ok)

    def test_add_and_verify(self):
        token = self.store.add_user("alice", "operator")
        self.assertTrue(token.startswith("omni_"))
        result = self.store.verify(token)
        self.assertTrue(result.ok)
        self.assertEqual("alice", result.user.name)
        self.assertEqual("operator", result.user.role)

    def test_persisted_across_reload(self):
        token = self.store.add_user("bob", "viewer")
        reloaded = UserStore(self.path)
        self.assertTrue(reloaded.verify(token).ok)
        self.assertFalse(reloaded.verify("wrong").ok)

    def test_file_mode_is_restricted(self):
        self.store.add_user("alice", "viewer")
        mode = os.stat(self.path).st_mode & 0o777
        self.assertEqual(0o600, mode)

    def test_wrong_token_fails(self):
        self.store.add_user("alice", "viewer")
        result = self.store.verify("omni_not-the-right-token")
        self.assertFalse(result.ok)
        self.assertEqual("unknown token", result.reason)

    def test_empty_token_fails(self):
        self.store.add_user("alice", "viewer")
        self.assertFalse(self.store.verify("").ok)

    def test_expired_token_fails(self):
        token = self.store.add_user("alice", "viewer", valid_days=1)
        entry = self.store._users["alice"]
        entry["expires"] = int(time.time()) - 10
        result = self.store.verify(token)
        self.assertFalse(result.ok)
        self.assertEqual("token expired", result.reason)

    def test_add_existing_replaces(self):
        first = self.store.add_user("alice", "viewer")
        second = self.store.add_user("alice", "operator")
        self.assertNotEqual(first, second)
        self.assertFalse(self.store.verify(first).ok)
        result = self.store.verify(second)
        self.assertTrue(result.ok)
        self.assertEqual("operator", result.user.role)

    def test_bad_role_rejected(self):
        with self.assertRaises(ValueError):
            self.store.add_user("alice", "superuser")

    def test_bad_name_rejected(self):
        for name in ("", "a" * 65, "has/slash"):
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    self.store.add_user(name, "viewer")

    def test_remove(self):
        token = self.store.add_user("alice", "viewer")
        self.assertTrue(self.store.remove_user("alice"))
        self.assertFalse(self.store.verify(token).ok)
        self.assertFalse(self.store.remove_user("alice"))

    def test_corrupt_store_rejected(self):
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write('{"users": {"x": {"role": "nope"}}}')
        with self.assertRaises(ValueError):
            UserStore(self.path)

    def test_last_seen_updated(self):
        token = self.store.add_user("alice", "viewer")
        self.store.verify(token)
        self.assertGreater(self.store.get("alice").last_seen, 0)


class RateLimiterTest(unittest.TestCase):
    def test_allows_until_limit(self):
        rl = RateLimiter()
        for _ in range(FAIL_LIMIT - 1):
            rl.record_failure("ip")
        self.assertTrue(rl.allow("ip"))
        rl.record_failure("ip")  # reaches the limit
        self.assertFalse(rl.allow("ip"))

    def test_success_clears(self):
        rl = RateLimiter()
        for _ in range(FAIL_LIMIT):
            rl.record_failure("ip")
        self.assertFalse(rl.allow("ip"))
        rl.record_success("ip")
        self.assertTrue(rl.allow("ip"))

    def test_peers_are_independent(self):
        rl = RateLimiter()
        for _ in range(FAIL_LIMIT):
            rl.record_failure("ip1")
        self.assertFalse(rl.allow("ip1"))
        self.assertTrue(rl.allow("ip2"))

    def test_window_expires(self):
        # short lockout so only the failure window matters
        rl = RateLimiter(limit=FAIL_LIMIT, window=0.05, lockout=0.01)
        for _ in range(FAIL_LIMIT):
            rl.record_failure("ip")
        self.assertFalse(rl.allow("ip"))
        time.sleep(0.06)
        rl.record_failure("ip")  # window cleared, this is failure #1 again
        self.assertTrue(rl.allow("ip"))

    def test_forget(self):
        rl = RateLimiter()
        for _ in range(FAIL_LIMIT):
            rl.record_failure("ip")
        rl.forget("ip")
        self.assertTrue(rl.allow("ip"))


class TokenTest(unittest.TestCase):
    def test_tokens_are_unique_and_hashed(self):
        tokens = {generate_token() for _ in range(50)}
        self.assertEqual(50, len(tokens))
        self.assertNotEqual(hash_token("a"), hash_token("b"))


if __name__ == "__main__":
    unittest.main()
