"""Role-based access control for the WS gateway.

A policy maps each role to:
  * the Foxglove ops it may send client -> server,
  * which topics it may publish/advertise,
  * which services it may call,
  * which server -> client messages it may receive (the subscription
    filter; Phase 4 item 6 will tighten this into a real topic
    whitelist so the phone never sees the full ROS graph).

Policy decisions fail closed: any op/topic not explicitly allowed by
the role is denied (``admin`` allows everything).

An optional JSON policy file (``policy.json``) can override the built-in
defaults, e.g. ``{"operator": {"publish_topics": [...], ...}}``; partial
files merge over the defaults per role.
"""

from __future__ import annotations

import fnmatch
import json
import os
from dataclasses import dataclass

from .auth_store import ROLES

__all__ = ["Policy", "PolicyDecision", "match_pattern"]

# Foxglove protocol v1 client -> server ops.
CLIENT_OPS = (
    "subscribe",
    "unsubscribe",
    "publish",
    "advertise",
    "unadvertise",
    "service_call",
    "log",
    "get_parameter_types",
    "get_parameters",
    "set_parameters",
)

# Ops that carry a topic the policy must match.
TOPIC_OPS = ("subscribe", "unsubscribe", "publish", "advertise", "unadvertise")
SERVICE_OPS = ("service_call",)


def match_pattern(pattern: str, name: str) -> bool:
    """fnmatch-style match; patterns like ``/omni/safety/*`` or exact."""
    return fnmatch.fnmatchcase(name, pattern)


@dataclass(frozen=True)
class RoleRule:
    ops: frozenset[str]
    publish_topics: tuple[str, ...]
    service_topics: tuple[str, ...]
    receive_topics: tuple[str, ...] = ()  # empty = allow all (V1 default)
    receive_services: tuple[str, ...] = ()  # empty = allow all (V1 default)
    allow_all: bool = False


@dataclass(frozen=True)
class PolicyDecision:
    allowed: bool
    reason: str = ""


DEFAULT_RULES: dict[str, RoleRule] = {
    "viewer": RoleRule(
        ops=frozenset({"subscribe", "unsubscribe"}),
        publish_topics=(),
        service_topics=(),
    ),
    "operator": RoleRule(
        ops=frozenset({"subscribe", "unsubscribe", "publish", "advertise",
                       "unadvertise", "service_call"}),
        publish_topics=(
            "/omni/cmd_vel/*",
            "/omni/safety/*",
            "/omni/mission/*",
            "/omni/navigation/*",
            "/rosdeck/*",
        ),
        service_topics=(
            "/omni/safety/*",
            "/omni/mission/*",
            "/omni/routes/*",
            "/omni/navigation/*",
            "/rosdeck/*",
        ),
    ),
    "admin": RoleRule(
        ops=frozenset(CLIENT_OPS),
        publish_topics=(),
        service_topics=(),
        allow_all=True,
    ),
}


class Policy:
    """Loads policy (file over defaults) and answers access questions."""

    def __init__(self, rules: dict[str, RoleRule]):
        unknown = set(rules) - set(ROLES)
        if unknown:
            raise ValueError(f"policy has unknown roles: {sorted(unknown)}")
        self.rules = rules

    @classmethod
    def load(cls, path: str | None) -> "Policy":
        rules = {role: rule for role, rule in DEFAULT_RULES.items()}
        if path and os.path.isfile(path):
            with open(path, encoding="utf-8") as fh:
                override = json.load(fh)
            if not isinstance(override, dict):
                raise ValueError("policy.json must be an object")
            for role, entry in override.items():
                if role not in ROLES:
                    raise ValueError(f"policy.json: unknown role {role!r}")
                base = rules[role]
                merged = _merge_rule(base, entry)
                rules[role] = merged
        return cls(rules)

    def rule(self, role: str) -> RoleRule:
        try:
            return self.rules[role]
        except KeyError:
            raise ValueError(f"unknown role {role!r}")

    def check_client_op(self, role: str, op: str, topic: str | None = None) -> PolicyDecision:
        rule = self.rule(role)
        if rule.allow_all:
            return PolicyDecision(True)
        if op not in rule.ops:
            return PolicyDecision(False, f"op {op!r} not allowed for role {role!r}")
        if op in TOPIC_OPS and op in ("publish", "advertise"):
            if topic is None:
                return PolicyDecision(False, "publish op without topic")
            if not any(match_pattern(p, topic) for p in rule.publish_topics):
                return PolicyDecision(False, f"publish to {topic!r} denied")
        if op in SERVICE_OPS:
            if topic is None:
                return PolicyDecision(False, "service_call without topic")
            if not any(match_pattern(p, topic) for p in rule.service_topics):
                return PolicyDecision(False, f"service call {topic!r} denied")
        return PolicyDecision(True)

    def check_server_op(self, role: str, op: str, topic: str | None = None) -> PolicyDecision:
        """Server -> client direction: what may this role *receive*."""
        rule = self.rule(role)
        if rule.allow_all:
            return PolicyDecision(True)
        if op in ("advertise", "publish") and topic is not None:
            if rule.receive_topics and not any(
                match_pattern(p, topic) for p in rule.receive_topics
            ):
                return PolicyDecision(False, f"receive {topic!r} filtered")
        if op == "advertise_services" and topic is not None:
            if rule.receive_services and not any(
                match_pattern(p, topic) for p in rule.receive_services
            ):
                return PolicyDecision(False, f"service {topic!r} filtered")
        return PolicyDecision(True)


def _merge_rule(base: RoleRule, entry: dict) -> RoleRule:
    if not isinstance(entry, dict):
        raise ValueError("policy.json role entries must be objects")
    if set(entry) - {"ops", "publish_topics", "service_topics",
                     "receive_topics", "receive_services", "allow_all"}:
        raise ValueError("policy.json: unknown role field")
    ops = base.ops
    if entry.get("ops") is not None:
        if not isinstance(entry["ops"], list):
            raise ValueError("policy.json: 'ops' must be a list")
        ops = frozenset(entry["ops"])
    publish = tuple(entry.get("publish_topics", base.publish_topics))
    services = tuple(entry.get("service_topics", base.service_topics))
    recv_topics = tuple(entry.get("receive_topics", base.receive_topics))
    recv_services = tuple(entry.get("receive_services", base.receive_services))
    allow_all = bool(entry.get("allow_all", base.allow_all))
    return RoleRule(
        ops=ops,
        publish_topics=publish,
        service_topics=services,
        receive_topics=recv_topics,
        receive_services=recv_services,
        allow_all=allow_all,
    )
