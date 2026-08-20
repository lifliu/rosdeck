"""Local mirror of the frozen omni_robot_interfaces docking constants.

The generated bindings are the source of truth; these mirrors exist so the
pure (rclpy-free) core modules can be unit-tested on machines without ROS,
the same way ``omni_mission_manager`` mirrors its contract. The values are
pinned against the IDL sources by ``omni_robot_interfaces`` CI
(``ci/check_contract_constants.py``), including the cross-file rule that
the *shared* codes (3000/3001/3003/3006/3007/3008) are uniform across
ReturnToDock / Dock / Undock.

Note that the non-shared codes share numeric slots across actions
(3004 and 3005 mean different things in Dock, Undock and ReturnToDock),
so reason names are looked up per action table, not from a flat map.
"""

# --- shared codes (uniform across the three docking actions) ---
REASON_OK = 3000
REASON_REJECTED = 3001
REASON_DOCK_NOT_FOUND = 3003
REASON_ABORTED = 3006
REASON_USER_CANCELED = 3007
REASON_CONTROL_DENIED = 3008

# --- Dock-only ---
REASON_LOCALIZATION_LOST = 3002          # Dock / Undock (same slot)
REASON_APPROACH_TIMEOUT = 3004
REASON_CHARGE_NOT_CONFIRMED = 3005

# --- Undock-only ---
REASON_MOVE_TIMEOUT = 3004               # shares the slot with Dock's 3004

# --- ReturnToDock-only (the mission manager speaks this action; the
# --- names are kept here so status text renders consistently) ---
REASON_LOCALIZATION_NOT_READY = 3002
REASON_MISSION_ACTIVE = 3004
REASON_NAVIGATION_FAILED = 3005
REASON_DOCK_FAILED = 3009

# --- DockStatus.msg states ---
STATE_IDLE = 0
STATE_UNDOCKING = 1
STATE_RETURNING = 2
STATE_FINAL_APPROACH = 3
STATE_DOCKED = 4
STATE_CHARGING = 5
STATE_FAULT = 6

# --- Dock.Feedback states ---
DOCK_FB_ACQUIRING = 1
DOCK_FB_SERVING = 2
DOCK_FB_WAITING_CHARGE = 3

# --- Undock.Feedback states ---
UNDOCK_FB_ACQUIRING = 1
UNDOCK_FB_MOVING = 2

# --- RobotState localization (mirror; the servo is gated on this) ---
LOC_UNKNOWN = 0
LOC_DEGRADED = 1
LOC_LOST = 2
LOC_LOCALIZED = 3

# --- Control-authority string protocol. The gateway (Phase 0, see
# rosdeck_robot_bridge/doc/product_bringup_and_docking.md section 4)
# implements leases on the string topics below. The typed
# /omni/control/authority service is declared in the IDL but has no
# provider in this repository yet, so clients speak the string protocol
# until the gateway facade lands.
ACTION_ACQUIRE = "acquire"
ACTION_HEARTBEAT = "heartbeat"
ACTION_RELEASE = "release"

STATUS_PREFIX_ACQUIRED = "acquired:"

# Client-id convention: "<prefix><request_id>". The gateway validates
# [A-Za-z0-9_-], max 64 chars, so "<prefix>" + up to 53 chars fits.
CLIENT_PREFIX = "docking-"
# Mission-manager return-chain requests carry this prefix (convention
# with the ReturnToDock chain); DockStatus reports such ops as
# STATE_RETURNING (reserved semantics).
RTD_CLIENT_PREFIX = "docking-rtd-"

# Gateway lease parameters (zsibot_adapter): 5 s lease, 10 s acquire
# timeout. We heartbeat faster than the lease expiry and treat "no
# acquired:<me> status for 1 s" as lease lost.
LEASE_TIMEOUT_SEC = 5.0
ACQUIRE_TIMEOUT_SEC = 5.0
HEARTBEAT_PERIOD_SEC = 1.0
LEASE_LOST_GRACE_SEC = 1.0

DOCK_REASONS = {
    REASON_OK: "ok",
    REASON_REJECTED: "rejected",
    REASON_LOCALIZATION_LOST: "localization lost",
    REASON_DOCK_NOT_FOUND: "dock not found",
    REASON_APPROACH_TIMEOUT: "approach timeout",
    REASON_CHARGE_NOT_CONFIRMED: "charge not confirmed",
    REASON_ABORTED: "aborted",
    REASON_USER_CANCELED: "user canceled",
    REASON_CONTROL_DENIED: "control denied",
}
UNDOCK_REASONS = {
    REASON_OK: "ok",
    REASON_REJECTED: "rejected",
    REASON_LOCALIZATION_LOST: "localization lost",
    REASON_DOCK_NOT_FOUND: "dock not found",
    REASON_MOVE_TIMEOUT: "move timeout",
    REASON_ABORTED: "aborted",
    REASON_USER_CANCELED: "user canceled",
    REASON_CONTROL_DENIED: "control denied",
}
RETURN_TO_DOCK_REASONS = {
    REASON_OK: "ok",
    REASON_REJECTED: "rejected",
    REASON_LOCALIZATION_NOT_READY: "localization not ready",
    REASON_DOCK_NOT_FOUND: "dock not found",
    REASON_MISSION_ACTIVE: "mission active",
    REASON_NAVIGATION_FAILED: "navigation failed",
    REASON_ABORTED: "aborted",
    REASON_USER_CANCELED: "user canceled",
    REASON_CONTROL_DENIED: "control denied",
    REASON_DOCK_FAILED: "dock failed",
}
STATE_NAMES = {
    STATE_IDLE: "idle",
    STATE_UNDOCKING: "undocking",
    STATE_RETURNING: "returning",
    STATE_FINAL_APPROACH: "final_approach",
    STATE_DOCKED: "docked",
    STATE_CHARGING: "charging",
    STATE_FAULT: "fault",
}


def dock_reason_name(code):
    return DOCK_REASONS.get(code, "unknown({})".format(code))


def undock_reason_name(code):
    return UNDOCK_REASONS.get(code, "unknown({})".format(code))


def return_to_dock_reason_name(code):
    return RETURN_TO_DOCK_REASONS.get(code, "unknown({})".format(code))


def dock_status_name(state):
    return STATE_NAMES.get(state, "unknown({})".format(state))
