"""User store for the WS gateway: tokens, roles, login rate limiting.

The store is a single JSON file (``users.json``) owned by the ``rosdeck``
service account. Tokens are high-entropy random strings (192 bits); only
their SHA-256 hash is persisted, so the file is safe to back up and the
clear-text token is shown exactly once, at creation time.

Roles (least to most privileged): ``viewer`` < ``operator`` < ``admin``.
The role-to-permission mapping lives in :mod:`omni_ws_gateway.policy`;
this module only knows role names.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import tempfile
import time
from dataclasses import dataclass

__all__ = [
    "ROLES",
    "LoginResult",
    "RateLimiter",
    "User",
    "UserStore",
    "chown_to_rosdeck",
    "generate_token",
    "hash_token",
]

ROLES = ("viewer", "operator", "admin")

# Login rate limiting: this many failures from one peer within the window
# blocks that peer for the lockout duration.
FAIL_LIMIT = 5
FAIL_WINDOW_SECONDS = 60.0
LOCKOUT_SECONDS = 300.0


def generate_token() -> str:
    """Generate a user-facing token (shown once at creation time)."""
    return "omni_" + secrets.token_urlsafe(24)


def hash_token(token: str) -> str:
    """SHA-256 of the token; tokens are 192-bit random, so a plain hash
    (no salt/stretching) is sufficient."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def chown_to_rosdeck(path: str, recursive: bool = False) -> None:
    """Best-effort chown of a path (and optionally its contents) to the
    ``rosdeck`` service account when running as root. No-op otherwise or
    when the account does not exist (e.g. in a container)."""
    if not (hasattr(os, "geteuid") and os.geteuid() == 0):
        return
    uid = gid = None
    try:
        with open("/etc/passwd", encoding="utf-8") as fh:
            for line in fh:
                parts = line.rstrip("\n").split(":")
                if len(parts) >= 3 and parts[0] == "rosdeck":
                    uid, gid = int(parts[2]), int(parts[3])
                    break
    except OSError:
        return
    if uid is None:
        return
    targets = [path]
    if recursive and os.path.isdir(path):
        targets.extend(
            os.path.join(root, name)
            for root, _dirs, files in os.walk(path)
            for name in files
        )
    for target in targets:
        try:
            os.chown(target, uid, gid)
        except OSError:
            pass


@dataclass(frozen=True)
class User:
    name: str
    role: str
    expires: int  # unix ts; 0 = never
    created: int
    last_seen: int


@dataclass(frozen=True)
class LoginResult:
    ok: bool
    user: User | None = None
    reason: str = ""


class UserStore:
    """Loads/saves the JSON user store with atomic replacement writes."""

    def __init__(self, path: str):
        self.path = path
        self._users: dict[str, dict] = {}
        self.load()

    def load(self) -> None:
        if not os.path.exists(self.path):
            self._users = {}
            return
        with open(self.path, encoding="utf-8") as fh:
            data = json.load(fh)
        users = data.get("users", {})
        if not isinstance(users, dict):
            raise ValueError("users.json: 'users' must be an object")
        for name, entry in users.items():
            if (
                not isinstance(entry, dict)
                or entry.get("role") not in ROLES
                or not isinstance(entry.get("token_sha256"), str)
            ):
                raise ValueError(f"users.json: bad entry for {name!r}")
            self._users[name] = entry

    def save(self) -> None:
        """Atomically write the store (temp file + rename, 0600)."""
        directory = os.path.dirname(self.path) or "."
        fd, tmp = tempfile.mkstemp(dir=directory, prefix=".users.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump({"version": 1, "users": self._users}, fh, indent=2)
                fh.write("\n")
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
        # Root may create the file during deploy; hand it to the service
        # account so the gateway (running as rosdeck) can update it later.
        chown_to_rosdeck(self.path)

    def list_users(self) -> list[User]:
        now = int(time.time())
        return [self._to_user(name, now) for name in sorted(self._users)]

    def _to_user(self, name: str, now: int | None = None) -> User:
        entry = self._users[name]
        now = now if now is not None else int(time.time())
        return User(
            name=name,
            role=entry["role"],
            expires=int(entry.get("expires", 0)),
            created=int(entry.get("created", 0)),
            last_seen=int(entry.get("last_seen", 0)),
        )

    def get(self, name: str) -> User | None:
        if name not in self._users:
            return None
        return self._to_user(name)

    def add_user(self, name: str, role: str, valid_days: int = 0) -> str:
        """Create a user; returns the clear-text token (shown once).

        Re-adding an existing name is a replacement (new token, new role).
        """
        if role not in ROLES:
            raise ValueError(f"role must be one of {ROLES}, got {role!r}")
        if not name or "/" in name or len(name) > 64:
            raise ValueError("user name must be 1-64 chars without '/'")
        token = generate_token()
        now = int(time.time())
        self._users[name] = {
            "token_sha256": hash_token(token),
            "role": role,
            "created": now,
            "expires": now + valid_days * 86400 if valid_days else 0,
            "last_seen": 0,
        }
        self.save()
        return token

    def remove_user(self, name: str) -> bool:
        if name not in self._users:
            return False
        del self._users[name]
        self.save()
        return True

    def verify(self, token: str) -> LoginResult:
        """Check a login token; returns the user or a failure reason."""
        if not token or not isinstance(token, str):
            return LoginResult(ok=False, reason="missing token")
        digest = hash_token(token)
        for name, entry in self._users.items():
            if entry["token_sha256"] == digest:
                user = self._to_user(name)
                if user.expires and user.expires < int(time.time()):
                    return LoginResult(ok=False, reason="token expired")
                # best-effort last_seen update (do not fail login on write)
                entry["last_seen"] = int(time.time())
                try:
                    self.save()
                except OSError:
                    pass
                return LoginResult(ok=True, user=user)
        return LoginResult(ok=False, reason="unknown token")


class RateLimiter:
    """In-memory per-peer login failure limiter (process-lifetime state)."""

    def __init__(
        self,
        limit: int = FAIL_LIMIT,
        window: float = FAIL_WINDOW_SECONDS,
        lockout: float = LOCKOUT_SECONDS,
    ):
        self.limit = limit
        self.window = window
        self.lockout = lockout
        self._fails: dict[str, list[float]] = {}
        self._locked_until: dict[str, float] = {}

    def allow(self, peer: str) -> bool:
        now = time.monotonic()
        until = self._locked_until.get(peer, 0.0)
        if now < until:
            return False
        return True

    def record_failure(self, peer: str) -> None:
        now = time.monotonic()
        fails = [t for t in self._fails.get(peer, []) if now - t < self.window]
        fails.append(now)
        self._fails[peer] = fails
        if len(fails) >= self.limit:
            self._locked_until[peer] = now + self.lockout
            self._fails[peer] = []

    def record_success(self, peer: str) -> None:
        self._fails.pop(peer, None)
        self._locked_until.pop(peer, None)

    def forget(self, peer: str) -> None:
        self._fails.pop(peer, None)
        self._locked_until.pop(peer, None)
