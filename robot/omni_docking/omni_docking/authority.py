"""Pure helpers for the gateway control-authority string protocol.

The gateway (rosdeck_robot_bridge) implements velocity-lease authority on
two std_msgs/String topics:

  /rosdeck/control_command  "<action>:<client_id>"
      action in {acquire, release, heartbeat}; while an E-stop is latched
      only heartbeat is accepted.
  /rosdeck/control_status   "acquired:<client_id>"  (republished ~2 Hz)
      or "error:<reason>" when no lease is held.

The arbiter then routes /omni/cmd_vel/docking only while the DOCKING
owner is the active lease holder, so this package must acquire the lease
with its own client id before it ever publishes a non-zero twist.

The typed ControlAuthority service is declared in omni_robot_interfaces
but currently has no provider; once the gateway facade lands these
helpers can be swapped out without touching the core.
"""

import re

from . import constants

_CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# request_id budget: 64 (gateway max) - len("docking-")
REQUEST_ID_MAX = 64 - len(constants.CLIENT_PREFIX)
_SAFE_RE = re.compile(r"[^A-Za-z0-9_-]")


def make_client_id(request_id):
    """Build and validate the client id "docking-<request_id>".

    Raises ValueError when the result would not pass the gateway's
    validation (charset [A-Za-z0-9_-], max 64 chars). The request_id is
    sanitized first (invalid chars dropped) so an App-generated UUID
    works; an empty request_id is rejected outright (a lease must be
    attributable).
    """
    if not request_id or not str(request_id).strip():
        raise ValueError("request_id must be non-empty")
    sanitized = _SAFE_RE.sub("", str(request_id))[:REQUEST_ID_MAX]
    if not sanitized:
        raise ValueError("request_id has no gateway-safe characters")
    client_id = constants.CLIENT_PREFIX + sanitized
    if not _CLIENT_ID_RE.match(client_id):
        raise ValueError("client id rejected: {!r}".format(client_id))
    return client_id


def command(action, client_id):
    """Render a /rosdeck/control_command payload."""
    if action not in (constants.ACTION_ACQUIRE,
                      constants.ACTION_RELEASE,
                      constants.ACTION_HEARTBEAT):
        raise ValueError("unknown control action {!r}".format(action))
    if not _CLIENT_ID_RE.match(client_id):
        raise ValueError("client id rejected: {!r}".format(client_id))
    return "{}:{}".format(action, client_id)


def parse_status(text):
    """Parse a /rosdeck/control_status payload.

    Returns (state, client_id): state is "acquired" | "error" |
    "unknown", client_id the owner ("error:" payloads keep the reason
    text in client_id for diagnostics; "unknown" for anything else).
    """
    if not text or not isinstance(text, str):
        return ("unknown", "")
    text = text.strip()
    if text.startswith(constants.STATUS_PREFIX_ACQUIRED):
        owner = text[len(constants.STATUS_PREFIX_ACQUIRED):].strip()
        if owner:
            return ("acquired", owner)
        return ("unknown", "")
    if text.startswith("error:"):
        return ("error", text[len("error:"):].strip())
    return ("unknown", "")


def holding(status_text, client_id):
    """True when the status text names *this* client as lease holder."""
    state, owner = parse_status(status_text)
    return state == "acquired" and owner == client_id


def is_return_chain(client_id):
    """True for mission-manager return-chain client ids (rtd prefix)."""
    return client_id.startswith(constants.RTD_CLIENT_PREFIX)
