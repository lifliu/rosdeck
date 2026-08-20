"""V1 contract constants, mirrored locally from omni_robot_interfaces.

Single source of truth is the IDL in the omni_robot_interfaces repo;
``ci/check_contract_constants.py`` there pins every value below in CI.
We mirror instead of importing generated constants because the rosidl
Humble generators expose ``.action``-section constants on the ADJACENT
type (FEEDBACK-section constants surface on the Result type and
RESULT-section constants on the Feedback type), so the generated names
would be misleading at call sites.
"""

# --- MissionStatus.msg / RobotState.msg (msg-section constants) ---
MISSION_NONE = 0
MISSION_PENDING = 1
MISSION_EXECUTING = 2
MISSION_PAUSED = 3
MISSION_SUCCEEDED = 4
MISSION_CANCELED = 5
MISSION_FAILED = 6
MISSION_INTERRUPTED = 7

# MissionEvent.msg
EVENT_DISPATCHED = 0
EVENT_STARTED = 1
EVENT_PAUSED = 2
EVENT_RESUMED = 3
EVENT_CANCELED = 4
EVENT_SUCCEEDED = 5
EVENT_FAILED = 6
EVENT_INTERRUPTED = 7

# RobotState.msg: localization
LOC_UNKNOWN = 0
LOC_DEGRADED = 1
LOC_LOST = 2
LOC_LOCALIZED = 3

# RobotState.msg: control authority
AUTHORITY_NONE = 0
AUTHORITY_APP = 1
AUTHORITY_MISSION = 2
AUTHORITY_DOCKING = 3

# --- ExecuteInspection.action, result section (mirror) ---
REASON_OK = 0
REASON_REJECTED = 1
REASON_DUPLICATE = 2
REASON_ROUTE_NOT_FOUND = 3
REASON_MAP_MISMATCH = 4
REASON_LOCALIZATION_NOT_READY = 5
REASON_CONTROL_DENIED = 6
REASON_USER_CANCELED = 7
REASON_MISSION_FAILED = 8
REASON_MISSION_INTERRUPTED = 9

# --- FollowRoute.action, result section (mirror) ---
PLANNER_REASON_OK = 0
PLANNER_REASON_USER_CANCELED = 1
PLANNER_REASON_ABORTED = 2
PLANNER_REASON_GOAL_REJECTED = 3
PLANNER_REASON_MAP_MISMATCH = 4
PLANNER_REASON_LOCALIZATION_LOST = 5
PLANNER_REASON_HEARTBEAT_LOST = 6
PLANNER_REASON_TIMEOUT = 7

# --- FollowRoute.action, feedback section (mirror) ---
PLANNER_STATE_PLANNING = 1
PLANNER_STATE_EXECUTING = 2
PLANNER_STATE_PAUSED = 3

# --- MissionControl.srv, request section ---
CMD_PAUSE = 0
CMD_RESUME = 1
CMD_CANCEL = 2

# --- ControlAuthority.srv, request section ---
OP_ACQUIRE = 0
OP_RELEASE = 1
OP_RENEW = 2

# --- ReturnToDock.action, goal section (mirror; Phase 3 return-to-dock) ---
RTD_TRIGGER_USER = 0
RTD_TRIGGER_MISSION_COMPLETE = 1
RTD_TRIGGER_LOW_BATTERY = 2

# --- ReturnToDock.action, feedback section (mirror) ---
RTD_STATE_PREPARING = 1
RTD_STATE_NAVIGATING = 2
RTD_STATE_FINAL_APPROACH = 3
RTD_STATE_WAITING_CHARGE = 4
RTD_STATE_CHARGING = 5

# --- ReturnToDock.action, result section (mirror) ---
RTD_REASON_OK = 3000
RTD_REASON_REJECTED = 3001
RTD_REASON_LOCALIZATION_NOT_READY = 3002
RTD_REASON_DOCK_NOT_FOUND = 3003
RTD_REASON_MISSION_ACTIVE = 3004
RTD_REASON_NAVIGATION_FAILED = 3005
RTD_REASON_ABORTED = 3006
RTD_REASON_USER_CANCELED = 3007
RTD_REASON_CONTROL_DENIED = 3008
RTD_REASON_DOCK_FAILED = 3009

# --- Dock.action, result section (mirror; for reason mapping) ---
DOCK_REASON_OK = 3000
DOCK_REASON_REJECTED = 3001
DOCK_REASON_LOCALIZATION_LOST = 3002
DOCK_REASON_DOCK_NOT_FOUND = 3003
DOCK_REASON_APPROACH_TIMEOUT = 3004
DOCK_REASON_CHARGE_NOT_CONFIRMED = 3005
DOCK_REASON_ABORTED = 3006
DOCK_REASON_USER_CANCELED = 3007
DOCK_REASON_CONTROL_DENIED = 3008

# --- Dock.action, feedback section (mirror) ---
DOCK_STATE_ACQUIRING = 1
DOCK_STATE_SERVING = 2
DOCK_STATE_WAITING_CHARGE = 3

# Whole-chain progress weights for the return-to-dock legs: navigation,
# final approach (Dock ACQUIRING/SERVING), charge confirmation.
# They sum to 1.0.
RTD_NAV_WEIGHT = 0.6
RTD_APPROACH_WEIGHT = 0.3
RTD_CHARGE_WEIGHT = 0.1

# States in which a mission still owns the goal / can be controlled.
ACTIVE_STATES = (MISSION_PENDING, MISSION_EXECUTING, MISSION_PAUSED)
TERMINAL_STATES = (
    MISSION_SUCCEEDED,
    MISSION_CANCELED,
    MISSION_FAILED,
    MISSION_INTERRUPTED,
)


def reason_name(code, table):
    """Human-readable name for a mirrored constant value ('?' if unknown)."""
    for name, value in table.items():
        if value == code:
            return name
    return "?"


def execute_reason_name(code):
    return reason_name(
        code,
        {
            "REASON_OK": REASON_OK,
            "REASON_REJECTED": REASON_REJECTED,
            "REASON_DUPLICATE": REASON_DUPLICATE,
            "REASON_ROUTE_NOT_FOUND": REASON_ROUTE_NOT_FOUND,
            "REASON_MAP_MISMATCH": REASON_MAP_MISMATCH,
            "REASON_LOCALIZATION_NOT_READY": REASON_LOCALIZATION_NOT_READY,
            "REASON_CONTROL_DENIED": REASON_CONTROL_DENIED,
            "REASON_USER_CANCELED": REASON_USER_CANCELED,
            "REASON_MISSION_FAILED": REASON_MISSION_FAILED,
            "REASON_MISSION_INTERRUPTED": REASON_MISSION_INTERRUPTED,
        },
    )


def planner_reason_name(code):
    return reason_name(
        code,
        {
            "REASON_OK": PLANNER_REASON_OK,
            "REASON_USER_CANCELED": PLANNER_REASON_USER_CANCELED,
            "REASON_ABORTED": PLANNER_REASON_ABORTED,
            "REASON_GOAL_REJECTED": PLANNER_REASON_GOAL_REJECTED,
            "REASON_MAP_MISMATCH": PLANNER_REASON_MAP_MISMATCH,
            "REASON_LOCALIZATION_LOST": PLANNER_REASON_LOCALIZATION_LOST,
            "REASON_HEARTBEAT_LOST": PLANNER_REASON_HEARTBEAT_LOST,
            "REASON_TIMEOUT": PLANNER_REASON_TIMEOUT,
        },
    )


def mission_state_name(state):
    return reason_name(
        state,
        {
            "MISSION_NONE": MISSION_NONE,
            "MISSION_PENDING": MISSION_PENDING,
            "MISSION_EXECUTING": MISSION_EXECUTING,
            "MISSION_PAUSED": MISSION_PAUSED,
            "MISSION_SUCCEEDED": MISSION_SUCCEEDED,
            "MISSION_CANCELED": MISSION_CANCELED,
            "MISSION_FAILED": MISSION_FAILED,
            "MISSION_INTERRUPTED": MISSION_INTERRUPTED,
        },
    )


def rtd_reason_name(code):
    return reason_name(
        code,
        {
            "REASON_OK": RTD_REASON_OK,
            "REASON_REJECTED": RTD_REASON_REJECTED,
            "REASON_LOCALIZATION_NOT_READY":
                RTD_REASON_LOCALIZATION_NOT_READY,
            "REASON_DOCK_NOT_FOUND": RTD_REASON_DOCK_NOT_FOUND,
            "REASON_MISSION_ACTIVE": RTD_REASON_MISSION_ACTIVE,
            "REASON_NAVIGATION_FAILED": RTD_REASON_NAVIGATION_FAILED,
            "REASON_ABORTED": RTD_REASON_ABORTED,
            "REASON_USER_CANCELED": RTD_REASON_USER_CANCELED,
            "REASON_CONTROL_DENIED": RTD_REASON_CONTROL_DENIED,
            "REASON_DOCK_FAILED": RTD_REASON_DOCK_FAILED,
        },
    )


def dock_reason_name(code):
    return reason_name(
        code,
        {
            "REASON_OK": DOCK_REASON_OK,
            "REASON_REJECTED": DOCK_REASON_REJECTED,
            "REASON_LOCALIZATION_LOST": DOCK_REASON_LOCALIZATION_LOST,
            "REASON_DOCK_NOT_FOUND": DOCK_REASON_DOCK_NOT_FOUND,
            "REASON_APPROACH_TIMEOUT": DOCK_REASON_APPROACH_TIMEOUT,
            "REASON_CHARGE_NOT_CONFIRMED":
                DOCK_REASON_CHARGE_NOT_CONFIRMED,
            "REASON_ABORTED": DOCK_REASON_ABORTED,
            "REASON_USER_CANCELED": DOCK_REASON_USER_CANCELED,
            "REASON_CONTROL_DENIED": DOCK_REASON_CONTROL_DENIED,
        },
    )
