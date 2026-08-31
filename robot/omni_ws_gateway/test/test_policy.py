import json
import os
import sys
import tempfile
import unittest

sys.path.insert(
    0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from omni_ws_gateway import policy  # noqa: E402


class MatchPattern(unittest.TestCase):
    def test_exact(self):
        self.assertTrue(policy.match_pattern("/omni/robot_state",
                                             "/omni/robot_state"))
        self.assertFalse(policy.match_pattern("/omni/robot_state",
                                              "/omni/other"))

    def test_wildcard(self):
        self.assertTrue(policy.match_pattern("/omni/safety/*",
                                             "/omni/safety/estop"))
        self.assertTrue(policy.match_pattern("/omni/safety/*",
                                             "/omni/safety/a/b"))
        self.assertFalse(policy.match_pattern("/omni/safety/*",
                                              "/omni/safety"))

    def test_case_sensitive(self):
        self.assertFalse(policy.match_pattern("/OMNI/X", "/omni/x"))


class Defaults(unittest.TestCase):
    def setUp(self):
        self.pol = policy.Policy.load(None)

    def test_viewer_can_subscribe(self):
        d = self.pol.check_client_op("viewer", "subscribe",
                                     "/omni/robot_state")
        self.assertTrue(d.allowed)
        d = self.pol.check_client_op("viewer", "unsubscribe",
                                     "/omni/robot_state")
        self.assertTrue(d.allowed)

    def test_viewer_cannot_publish_or_advertise_or_call(self):
        for op in ("publish", "advertise", "service_call"):
            with self.subTest(op=op):
                d = self.pol.check_client_op("viewer", op, "/omni/safety/estop")
                self.assertFalse(d.allowed)

    def test_viewer_cannot_use_unknown_op(self):
        d = self.pol.check_client_op("viewer", "teleport")
        self.assertFalse(d.allowed)

    def test_operator_allowed_ops_and_topics(self):
        self.assertTrue(self.pol.check_client_op(
            "operator", "advertise", "/omni/cmd_vel/teleop").allowed)
        self.assertTrue(self.pol.check_client_op(
            "operator", "publish", "/omni/safety/estop_request").allowed)
        self.assertTrue(self.pol.check_client_op(
            "operator", "service_call", "/omni/safety/reset_estop").allowed)
        # teleop command topic is in the publish allowlist
        self.assertTrue(self.pol.check_client_op(
            "operator", "publish", "/rosdeck/control_command").allowed)

    def test_operator_denied_out_of_scope_topic(self):
        d = self.pol.check_client_op("operator", "publish",
                                     "/diagnostics")
        self.assertFalse(d.allowed)
        d = self.pol.check_client_op("operator", "service_call",
                                     "/omni/secret/service")
        self.assertFalse(d.allowed)

    def test_operator_cannot_call_parameter_ops(self):
        d = self.pol.check_client_op("operator", "set_parameters")
        self.assertFalse(d.allowed)

    def test_admin_allows_everything(self):
        self.assertTrue(self.pol.check_client_op("admin", "set_parameters",
                                                 "anything").allowed)
        self.assertTrue(self.pol.check_client_op("admin", "publish",
                                                 "/totally/random").allowed)
        self.assertTrue(self.pol.check_client_op("admin", "log").allowed)

    def test_publish_without_topic_denied(self):
        d = self.pol.check_client_op("operator", "publish")
        self.assertFalse(d.allowed)

    def test_unknown_role_raises(self):
        with self.assertRaises(ValueError):
            self.pol.check_client_op("superuser", "subscribe")

    def test_server_op_filtered_by_receive_topics(self):
        # V1 default: receive_topics empty -> allow all server data.
        self.assertTrue(self.pol.check_server_op("viewer", "publish",
                                                 "/anything").allowed)
        strict = policy.Policy({
            "viewer": policy.RoleRule(
                ops=frozenset({"subscribe"}),
                publish_topics=(),
                service_topics=(),
                receive_topics=("/omni/robot_state",),
            ),
        })
        self.assertTrue(strict.check_server_op("viewer", "publish",
                                               "/omni/robot_state").allowed)
        self.assertFalse(strict.check_server_op("viewer", "publish",
                                                "/diagnostics").allowed)
        # non-topic ops are unaffected by the receive filter
        self.assertTrue(strict.check_server_op("viewer", "serverInfo").allowed)


class PolicyFile(unittest.TestCase):
    def _load(self, obj):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "policy.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(obj, fh)
            return policy.Policy.load(path)

    def test_partial_override_merges_over_defaults(self):
        pol = self._load({"operator": {
            "publish_topics": ["/omni/cmd_vel/*", "/custom/*"],
        }})
        self.assertTrue(pol.check_client_op(
            "operator", "publish", "/custom/throttle").allowed)
        self.assertFalse(pol.check_client_op(
            "operator", "publish", "/rosdeck/control_command").allowed)
        # untouched fields keep the defaults
        self.assertTrue(pol.check_client_op(
            "operator", "service_call", "/omni/mission/dispatch").allowed)

    def test_ops_override(self):
        pol = self._load({"viewer": {"ops": ["subscribe", "log"]}})
        self.assertTrue(pol.check_client_op("viewer", "log").allowed)
        self.assertFalse(pol.check_client_op("viewer", "publish",
                                             "/omni/safety/x").allowed)

    def test_unknown_role_rejected(self):
        with self.assertRaises(ValueError):
            self._load({"god": {"allow_all": True}})

    def test_unknown_field_rejected(self):
        with self.assertRaises(ValueError):
            self._load({"viewer": {"bogus": 1}})

    def test_non_object_rejected(self):
        with self.assertRaises(ValueError):
            self._load(["viewer"])

    def test_non_dict_entry_rejected(self):
        with self.assertRaises(ValueError):
            self._load({"viewer": 42})

    def test_missing_file_is_defaults(self):
        pol = policy.Policy.load("/nonexistent/policy.json")
        self.assertTrue(pol.check_client_op("admin", "log").allowed)


if __name__ == "__main__":
    unittest.main()
