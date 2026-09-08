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

// /omni/mission/status 使用 reliable + transient_local：晚加入订阅者先取得当前
// 快照，随后仍必须用周期 heartbeat 判定新鲜度，不能无限沿用缓存状态。
export interface MissionStatusMessage {
  header: unknown;
  state: number;
  mission_id: string;
  request_id: string;
  sequence: number;
  route_id: string;
  map_id: string;
  map_version: string;
  progress: number;
  current_checkpoint_id: string;
  status_text: string;
  reason_code: number;
  reason_text: string;
  request_source: string;
  map_checksum: string;
  route_checksum: string;
  requested_at: unknown;
  deadline: unknown;
}

export const CHECKPOINT_RESULT_STATUS = {
  SUCCEEDED: 0,
  FAILED: 1,
  SKIPPED: 2,
} as const;
export type CheckpointResultStatus =
  (typeof CHECKPOINT_RESULT_STATUS)[keyof typeof CHECKPOINT_RESULT_STATUS];

/** Mission SQLite 中按 sequence 排序的持久巡检证据摘要。 */
export interface CheckpointEvidenceResult {
  stamp: unknown;
  missionId: string;
  sequence: number;
  checkpointId: string;
  actionType: string;
  status: CheckpointResultStatus;
  attempts: number;
  reason: string;
  artifactPath: string;
  resultJson: string;
  poseValid: boolean;
  pose: unknown;
  mapId: string;
  mapVersion: string;
  mapChecksum: string;
  softwareVersion: string;
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
  mapVersion: string;
  mapChecksum: string;
  routeChecksum: string;
  pointCount: number;
  distanceM: number;
}

export const ROUTE_CHECKPOINT_ACTION_TYPE = {
  DWELL: 0,
  PHOTO: 1,
  RECORD: 2,
  RECOGNIZE: 3,
} as const;
export type RouteCheckpointActionType =
  (typeof ROUTE_CHECKPOINT_ACTION_TYPE)[keyof typeof ROUTE_CHECKPOINT_ACTION_TYPE];

export const ROUTE_CHECKPOINT_FAILURE = {
  FAIL_MISSION: 0,
  SKIP: 1,
} as const;
export type RouteCheckpointFailure =
  (typeof ROUTE_CHECKPOINT_FAILURE)[keyof typeof ROUTE_CHECKPOINT_FAILURE];

/** 手机编辑器使用的检查点动作；未被 type 选中的参数始终保持零值。 */
export interface RouteCheckpointActionConfig {
  type: RouteCheckpointActionType;
  dwellMs: number;
  photoCount: number;
  recordSeconds: number;
  recognizeTarget: string;
}

export interface RouteCheckpointConfig {
  checkpointId: string;
  pointIndex: number;
  onFailure: RouteCheckpointFailure;
  attempts: number;
  actions: RouteCheckpointActionConfig[];
}

export interface RouteCheckpointPlan {
  routeChecksum: string;
  pointCount: number;
  checkpoints: RouteCheckpointConfig[];
}

export interface UpdateRouteCheckpointsResponse {
  accepted: boolean;
  reasonCode: number;
  reasonText: string;
  routeChecksum: string;
}

export type RouteDispatchBlockReason =
  | 'legacy_map_binding'
  | 'unsupported_frame'
  | 'malformed_route';

const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;

/**
 * 返回路线不能安全派发的原因；null 表示路线具备完整、不可变的执行身份。
 *
 * 历史路线的空地图校验和只能用于展示和迁移，不能表示“匹配任意当前地图”。
 * 否则同名地图重建后，旧路线可能被错误地投放到新的坐标系中。
 */
export function getRouteDispatchBlockReason(
  route: RouteEntry,
): RouteDispatchBlockReason | null {
  if (
    !route.mapId ||
    !route.mapVersion ||
    !LOWERCASE_SHA256.test(route.mapChecksum)
  ) {
    return 'legacy_map_binding';
  }
  if (route.frameId !== 'omni_map') {
    return 'unsupported_frame';
  }
  if (!route.routeChecksum || route.pointCount < 2) {
    return 'malformed_route';
  }
  return null;
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
