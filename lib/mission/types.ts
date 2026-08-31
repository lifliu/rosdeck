// lib/mission/types.ts
//
// TypeScript mirror of the omni_robot_interfaces V1 mission IDL
// (MissionStatus.msg, MissionEvent.msg, MissionControl.srv,
// ListRoutes.srv, DispatchMission.srv, ExecuteInspection.action).
//
// Values are pinned by the omni_robot_interfaces CI
// (ci/check_contract_constants.py). Keep in sync with the IDL source —
// the App must not redefine mission semantics locally.

// MissionStatus.msg / RobotState.msg (values are identical by contract)
export const MISSION_STATE = {
  NONE: 0,
  PENDING: 1,
  EXECUTING: 2,
  PAUSED: 3,
  SUCCEEDED: 4,
  CANCELED: 5,
  FAILED: 6,
  INTERRUPTED: 7,
} as const;
export type MissionState = (typeof MISSION_STATE)[keyof typeof MISSION_STATE];

// Active (non-terminal) mission states.
export const ACTIVE_MISSION_STATES: readonly number[] = [
  MISSION_STATE.PENDING,
  MISSION_STATE.EXECUTING,
  MISSION_STATE.PAUSED,
];

// ExecuteInspection.action result (reused by DispatchMission.srv)
export const MISSION_REASON = {
  OK: 0,
  REJECTED: 1,
  DUPLICATE: 2,
  ROUTE_NOT_FOUND: 3,
  MAP_MISMATCH: 4,
  LOCALIZATION_NOT_READY: 5,
  CONTROL_DENIED: 6,
  USER_CANCELED: 7,
  MISSION_FAILED: 8,
  MISSION_INTERRUPTED: 9,
} as const;
export type MissionReason =
  (typeof MISSION_REASON)[keyof typeof MISSION_REASON];

// MissionEvent.msg
export const MISSION_EVENT = {
  DISPATCHED: 0,
  STARTED: 1,
  PAUSED: 2,
  RESUMED: 3,
  CANCELED: 4,
  SUCCEEDED: 5,
  FAILED: 6,
  INTERRUPTED: 7,
} as const;
export type MissionEventKind =
  (typeof MISSION_EVENT)[keyof typeof MISSION_EVENT];

// MissionControl.srv
export const MISSION_CONTROL_CMD = {
  PAUSE: 0,
  RESUME: 1,
  CANCEL: 2,
} as const;
export type MissionControlCmd =
  (typeof MISSION_CONTROL_CMD)[keyof typeof MISSION_CONTROL_CMD];

// RobotState.msg
export const LOCALIZATION_STATE = {
  UNKNOWN: 0,
  DEGRADED: 1,
  LOST: 2,
  LOCALIZED: 3,
} as const;
export type LocalizationState =
  (typeof LOCALIZATION_STATE)[keyof typeof LOCALIZATION_STATE];

// --- message shapes (CDR-decoded plain objects, IDL field names) ---

// /omni/mission/status (reliable + transient_local: late subscribers get
// the current snapshot, so no "waiting for first message" logic is needed)
export interface MissionStatusMessage {
  state: number;
  mission_id: string;
  request_id: string;
  sequence: number;
  route_id: string;
  map_id: string;
  map_version: string;
  progress: number;
  reason_code: number;
  reason_text: string;
}

// /omni/mission/events (reliable)
export interface MissionEventMessage {
  mission_id: string;
  sequence: number;
  event: number;
  mission_state: number;
  progress: number;
  reason_code: number;
  reason_text: string;
}

// Subset of /omni/robot_state the mission page shows.
export interface RobotStateStrip {
  localization_state: number;
  map_id: string;
  map_version: string;
  health_level: number;
  estop_latched: boolean;
  mission_state: number;
  battery_percentage: number;
}

// /omni/routes/list response (parallel arrays)
export interface RouteEntry {
  routeId: string;
  mapId: string;
  frameId: string;
  createdAt: string;
}

// /omni/mission/dispatch response
export interface DispatchResponse {
  accepted: boolean;
  reason_code: number;
  reason_text: string;
  mission_id: string;
}

// /omni/mission/control response
export interface ControlResponse {
  accepted: boolean;
  reason_code: number;
  reason_text: string;
}