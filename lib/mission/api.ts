// lib/mission/api.ts
//
// Service wrappers for the Mission Manager (omni_mission_manager).
// The App talks to the robot over the foxglove/rosbridge WS bridges,
// which do not carry ROS 2 actions — dispatch therefore goes through
// the DispatchMission service, not the ExecuteInspection action.
//
// Idempotency: (request_id, sequence). The App generates one request_id
// per dispatch intent and reuses it across retries of that intent; the
// Manager returns the original dispatch outcome for a replay instead of
// re-dispatching.

import type { Transport } from '../transport';
import {
  AUTONOMY_REQUEST_SOURCE,
  resolveMissionCommandSequence,
  toRosTime,
  type RosTime,
} from '../autonomy-runtime';
import {
  MISSION_CONTROL_CMD,
  type ControlResponse,
  type CheckpointEvidenceResult,
  type DispatchResponse,
  type MissionControlCmd,
  ROUTE_CHECKPOINT_ACTION_TYPE,
  ROUTE_CHECKPOINT_FAILURE,
  type RouteCheckpointActionConfig,
  type RouteCheckpointConfig,
  type RouteCheckpointPlan,
  type RouteEntry,
  type UpdateRouteCheckpointsResponse,
} from './types';

export const MISSION_DISPATCH_SERVICE = '/omni/mission/dispatch';
export const MISSION_DISPATCH_SERVICE_TYPE =
  'omni_robot_interfaces/srv/DispatchMission';
export const MISSION_CONTROL_SERVICE = '/omni/mission/control';
export const MISSION_CONTROL_SERVICE_TYPE =
  'omni_robot_interfaces/srv/MissionControl';
export const MISSION_LIST_ROUTES_SERVICE = '/omni/routes/list';
export const MISSION_LIST_ROUTES_SERVICE_TYPE =
  'omni_robot_interfaces/srv/ListRoutes';
export const MISSION_GET_ROUTE_CHECKPOINTS_SERVICE =
  '/omni/routes/checkpoints/get';
export const MISSION_GET_ROUTE_CHECKPOINTS_SERVICE_TYPE =
  'omni_robot_interfaces/srv/GetRouteCheckpoints';
export const MISSION_UPDATE_ROUTE_CHECKPOINTS_SERVICE =
  '/omni/routes/checkpoints/update';
export const MISSION_UPDATE_ROUTE_CHECKPOINTS_SERVICE_TYPE =
  'omni_robot_interfaces/srv/UpdateRouteCheckpoints';

export const MISSION_STATUS_TOPIC = '/omni/mission/status';
export const MISSION_STATUS_TYPE = 'omni_robot_interfaces/msg/MissionStatus';
export const MISSION_EVENTS_TOPIC = '/omni/mission/events';
export const MISSION_EVENTS_TYPE = 'omni_robot_interfaces/msg/MissionEvent';
export const MISSION_RESULTS_SERVICE = '/omni/mission/results';
export const MISSION_RESULTS_SERVICE_TYPE =
  'omni_robot_interfaces/srv/GetCheckpointResults';
export const ROBOT_STATE_TOPIC = '/omni/robot_state';
export const ROBOT_STATE_TYPE = 'omni_robot_interfaces/msg/RobotState';
/**
 * 巡检命令的端到端有效期，覆盖依赖准备与整条路线执行。
 *
 * UI 生成幂等请求信封和 API 缺省 deadline 必须共用这一处定义，避免不同入口
 * 对同一条路线采用不同超时语义。
 */
export const DEFAULT_INSPECTION_COMMAND_TTL_SEC = 30 * 60;
export const DEFAULT_INSPECTION_DEADLINE_MS =
  DEFAULT_INSPECTION_COMMAND_TTL_SEC * 1000;

// rosbridge and foxglove both deliver IDL field names as-is (snake_case);
// the camelCase fallback guards against a bridge that re-cases fields.
function field(obj: any, name: string): unknown {
  const camel = name.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
  return obj?.[name] ?? obj?.[camel];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') {
    const converted = Number(value);
    return Number.isSafeInteger(converted) ? converted : fallback;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : fallback;
  }
  return fallback;
}

function asBool(value: unknown): boolean {
  return value === true;
}

let requestSeq = 0;

/** One idempotency key per dispatch intent: stable across retries of
 *  the same tap, unique across taps. */
export function generateRequestId(): string {
  requestSeq = (requestSeq + 1) % 1296; // 36^2
  return `app-${Date.now().toString(36)}-${requestSeq.toString(36).padStart(2, '0')}`;
}

export interface DispatchOptions {
  routeId: string;
  requestId: string;
  sequence?: number;
  missionId?: string;
  mapId?: string;
  mapVersion?: string;
  source?: string;
  requestedAt?: RosTime;
  deadline?: RosTime;
  mapChecksum?: string;
  routeChecksum?: string;
}

function normalizeDispatchResponse(raw: any): DispatchResponse {
  return {
    accepted: asBool(field(raw, 'accepted')),
    reason_code: asNumber(field(raw, 'reason_code')),
    reason_text: asString(field(raw, 'reason_text')),
    mission_id: asString(field(raw, 'mission_id')),
  };
}

function normalizeControlResponse(raw: any): ControlResponse {
  return {
    accepted: asBool(field(raw, 'accepted')),
    reason_code: asNumber(field(raw, 'reason_code')),
    reason_text: asString(field(raw, 'reason_text')),
  };
}

function asStringArray(value: unknown): string[] {
  // ListRoutes 使用平行数组，不能过滤坏值后让后续资产元数据错位。
  return Array.isArray(value) ? value.map((v) => typeof v === 'string' ? v : '') : [];
}

function asNumberArray(value: unknown): number[] {
  const values = Array.isArray(value)
    ? value
    : ArrayBuffer.isView(value)
      ? Array.from(value as unknown as ArrayLike<unknown>)
      : [];
  return values.map((v) => asNumber(v));
}

/** React Native 各运行时不一定提供 TextEncoder，这里只计算 UTF-8 字节数。 */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export async function dispatchMission(
  transport: Transport,
  options: DispatchOptions,
): Promise<DispatchResponse> {
  const nowMs = Date.now();
  const raw = await transport.callService(
    MISSION_DISPATCH_SERVICE,
    MISSION_DISPATCH_SERVICE_TYPE,
    {
      mission_id: options.missionId ?? '',
      request_id: options.requestId,
      sequence: resolveMissionCommandSequence(options.sequence),
      map_id: options.mapId ?? '',
      map_version: options.mapVersion ?? '',
      route_id: options.routeId,
      checkpoint_ids: [],
      source: options.source ?? AUTONOMY_REQUEST_SOURCE,
      requested_at: options.requestedAt ?? toRosTime(nowMs),
      // deadline 覆盖准备与执行全程；30 分钟默认值既允许正常巡检完成，也能
      // 阻止离线队列在很久以后重放同一个物理运动命令。
      deadline: options.deadline ?? toRosTime(nowMs + DEFAULT_INSPECTION_DEADLINE_MS),
      map_checksum: options.mapChecksum ?? '',
      route_checksum: options.routeChecksum ?? '',
    },
  );
  return normalizeDispatchResponse(raw);
}

export async function controlMission(
  transport: Transport,
  command: MissionControlCmd,
  missionId?: string,
): Promise<ControlResponse> {
  const raw = await transport.callService(
    MISSION_CONTROL_SERVICE,
    MISSION_CONTROL_SERVICE_TYPE,
    {
      command,
      mission_id: missionId ?? '',
      request_id: generateRequestId(),
      sequence: 1,
    },
  );
  return normalizeControlResponse(raw);
}

/** Convenience wrappers around the three control commands. */
export const pauseMission = (t: Transport, missionId?: string) =>
  controlMission(t, MISSION_CONTROL_CMD.PAUSE, missionId);
export const resumeMission = (t: Transport, missionId?: string) =>
  controlMission(t, MISSION_CONTROL_CMD.RESUME, missionId);
export const cancelMission = (t: Transport, missionId?: string) =>
  controlMission(t, MISSION_CONTROL_CMD.CANCEL, missionId);

export async function listRoutes(transport: Transport): Promise<RouteEntry[]> {
  const raw = await transport.callService(
    MISSION_LIST_ROUTES_SERVICE,
    MISSION_LIST_ROUTES_SERVICE_TYPE,
    {},
  );
  const routeIds = asStringArray(field(raw, 'route_ids'));
  const mapIds = asStringArray(field(raw, 'map_ids'));
  const frameIds = asStringArray(field(raw, 'frame_ids'));
  const createdAt = asStringArray(field(raw, 'created_at'));
  const mapVersions = asStringArray(field(raw, 'map_versions'));
  const mapChecksums = asStringArray(field(raw, 'map_checksums'));
  const routeChecksums = asStringArray(field(raw, 'route_checksums'));
  const pointCounts = asNumberArray(field(raw, 'point_counts'));
  const distancesM = asNumberArray(field(raw, 'distances_m'));
  return routeIds.map((routeId, i) => ({
    routeId,
    mapId: mapIds[i] ?? '',
    frameId: frameIds[i] ?? '',
    createdAt: createdAt[i] ?? '',
    mapVersion: mapVersions[i] ?? '',
    mapChecksum: mapChecksums[i] ?? '',
    routeChecksum: routeChecksums[i] ?? '',
    pointCount: pointCounts[i] ?? 0,
    distanceM: distancesM[i] ?? 0,
  }));
}

function normalizeCheckpointAction(raw: any): RouteCheckpointActionConfig {
  return {
    type: asNumber(field(raw, 'type')) as RouteCheckpointActionConfig['type'],
    dwellMs: asNumber(field(raw, 'dwell_ms')),
    photoCount: asNumber(field(raw, 'photo_count')),
    recordSeconds: asNumber(field(raw, 'record_seconds')),
    recognizeTarget: asString(field(raw, 'recognize_target')),
  };
}

function normalizeCheckpoint(raw: any): RouteCheckpointConfig {
  const actions = field(raw, 'actions');
  return {
    checkpointId: asString(field(raw, 'checkpoint_id')),
    pointIndex: asNumber(field(raw, 'point_index')),
    onFailure: asNumber(field(raw, 'on_failure')) as RouteCheckpointConfig['onFailure'],
    attempts: asNumber(field(raw, 'attempts')),
    actions: Array.isArray(actions) ? actions.map(normalizeCheckpointAction) : [],
  };
}

/**
 * 在请求发出前复刻 Manager 的关键边界，给手机用户可定位的即时错误。
 * Manager 仍是最终权威，不能依赖客户端校验保护磁盘资产。
 */
export function validateRouteCheckpointPlan(
  checkpoints: RouteCheckpointConfig[],
  pointCount: number,
): string | null {
  if (!Number.isInteger(pointCount) || pointCount < 2) return '路线点数无效';
  if (checkpoints.length > 256) return '检查点数量不能超过 256 个';
  const ids = new Set<string>();
  const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  for (const checkpoint of checkpoints) {
    if (!safeId.test(checkpoint.checkpointId)) return '检查点名称格式无效';
    if (ids.has(checkpoint.checkpointId)) return `检查点名称重复：${checkpoint.checkpointId}`;
    ids.add(checkpoint.checkpointId);
    if (!Number.isInteger(checkpoint.pointIndex) || checkpoint.pointIndex < 0 ||
        checkpoint.pointIndex >= pointCount) return `检查点 ${checkpoint.checkpointId} 的位置超出路线`;
    if (![ROUTE_CHECKPOINT_FAILURE.FAIL_MISSION, ROUTE_CHECKPOINT_FAILURE.SKIP]
      .includes(checkpoint.onFailure)) return `检查点 ${checkpoint.checkpointId} 的失败策略无效`;
    if (!Number.isInteger(checkpoint.attempts) || checkpoint.attempts < 1 ||
        checkpoint.attempts > 3) return `检查点 ${checkpoint.checkpointId} 的重试次数应为 1 到 3`;
    if (checkpoint.actions.length < 1 || checkpoint.actions.length > 16) {
      return `检查点 ${checkpoint.checkpointId} 必须包含 1 到 16 个动作`;
    }
    for (const action of checkpoint.actions) {
      if (action.type === ROUTE_CHECKPOINT_ACTION_TYPE.DWELL &&
          (!Number.isInteger(action.dwellMs) || action.dwellMs < 100 || action.dwellMs > 60000)) {
        return '停留时间应为 100 到 60000 毫秒';
      }
      if (action.type === ROUTE_CHECKPOINT_ACTION_TYPE.PHOTO &&
          (!Number.isInteger(action.photoCount) || action.photoCount < 1 || action.photoCount > 20)) {
        return '拍照数量应为 1 到 20 张';
      }
      if (action.type === ROUTE_CHECKPOINT_ACTION_TYPE.RECORD &&
          (!Number.isFinite(action.recordSeconds) || action.recordSeconds < 1 ||
           action.recordSeconds > 600)) return '录像时长应为 1 到 600 秒';
      if (action.type === ROUTE_CHECKPOINT_ACTION_TYPE.RECOGNIZE &&
          (utf8ByteLength(action.recognizeTarget.trim()) < 1 ||
           utf8ByteLength(action.recognizeTarget.trim()) > 128)) {
        return '识别目标长度应为 1 到 128 字节';
      }
      if (![ROUTE_CHECKPOINT_ACTION_TYPE.DWELL, ROUTE_CHECKPOINT_ACTION_TYPE.PHOTO,
        ROUTE_CHECKPOINT_ACTION_TYPE.RECORD, ROUTE_CHECKPOINT_ACTION_TYPE.RECOGNIZE]
        .includes(action.type)) return '检查点动作类型无效';
    }
  }
  return null;
}

function toWireCheckpointAction(action: RouteCheckpointActionConfig) {
  return {
    type: action.type,
    dwell_ms: action.type === ROUTE_CHECKPOINT_ACTION_TYPE.DWELL ? action.dwellMs : 0,
    photo_count: action.type === ROUTE_CHECKPOINT_ACTION_TYPE.PHOTO ? action.photoCount : 0,
    record_seconds: action.type === ROUTE_CHECKPOINT_ACTION_TYPE.RECORD ? action.recordSeconds : 0,
    recognize_target: action.type === ROUTE_CHECKPOINT_ACTION_TYPE.RECOGNIZE
      ? action.recognizeTarget.trim()
      : '',
  };
}

function toWireCheckpoint(checkpoint: RouteCheckpointConfig) {
  return {
    checkpoint_id: checkpoint.checkpointId.trim(),
    point_index: checkpoint.pointIndex,
    on_failure: checkpoint.onFailure,
    attempts: checkpoint.attempts,
    actions: checkpoint.actions.map(toWireCheckpointAction),
  };
}

export async function getRouteCheckpoints(
  transport: Transport,
  routeId: string,
): Promise<RouteCheckpointPlan> {
  const raw = await transport.callService(
    MISSION_GET_ROUTE_CHECKPOINTS_SERVICE,
    MISSION_GET_ROUTE_CHECKPOINTS_SERVICE_TYPE,
    { route_id: routeId },
  );
  if (!asBool(field(raw, 'success'))) {
    throw new Error(asString(field(raw, 'reason_text')) || '读取路线检查点失败');
  }
  const checkpoints = field(raw, 'checkpoints');
  const plan: RouteCheckpointPlan = {
    routeChecksum: asString(field(raw, 'route_checksum')),
    pointCount: asNumber(field(raw, 'point_count')),
    checkpoints: Array.isArray(checkpoints) ? checkpoints.map(normalizeCheckpoint) : [],
  };
  const error = validateRouteCheckpointPlan(plan.checkpoints, plan.pointCount);
  if (!plan.routeChecksum || error) throw new Error(error || '路线 checksum 为空');
  return plan;
}

export async function updateRouteCheckpoints(
  transport: Transport,
  routeId: string,
  plan: RouteCheckpointPlan,
): Promise<UpdateRouteCheckpointsResponse> {
  const error = validateRouteCheckpointPlan(plan.checkpoints, plan.pointCount);
  if (error) throw new Error(error);
  if (!plan.routeChecksum) throw new Error('路线 checksum 为空，请重新读取路线');
  const raw = await transport.callService(
    MISSION_UPDATE_ROUTE_CHECKPOINTS_SERVICE,
    MISSION_UPDATE_ROUTE_CHECKPOINTS_SERVICE_TYPE,
    {
      route_id: routeId,
      expected_route_checksum: plan.routeChecksum,
      checkpoints: plan.checkpoints.map(toWireCheckpoint),
    },
  );
  return {
    accepted: asBool(field(raw, 'accepted')),
    reasonCode: asNumber(field(raw, 'reason_code')),
    reasonText: asString(field(raw, 'reason_text')),
    routeChecksum: asString(field(raw, 'route_checksum')),
  };
}

function normalizeCheckpointEvidence(raw: any): CheckpointEvidenceResult {
  return {
    stamp: field(field(raw, 'header'), 'stamp') ?? null,
    missionId: asString(field(raw, 'mission_id')),
    sequence: asNumber(field(raw, 'sequence')),
    checkpointId: asString(field(raw, 'checkpoint_id')),
    actionType: asString(field(raw, 'action_type')),
    status: asNumber(field(raw, 'status')) as CheckpointEvidenceResult['status'],
    attempts: asNumber(field(raw, 'attempts')),
    reason: asString(field(raw, 'reason')),
    artifactPath: asString(field(raw, 'artifact_path')),
    resultJson: asString(field(raw, 'result_json')),
    poseValid: asBool(field(raw, 'pose_valid')),
    pose: field(raw, 'pose') ?? null,
    mapId: asString(field(raw, 'map_id')),
    mapVersion: asString(field(raw, 'map_version')),
    mapChecksum: asString(field(raw, 'map_checksum')),
    softwareVersion: asString(field(raw, 'software_version')),
  };
}

/** 查询某次任务的持久证据，不依赖 transient topic 是否曾被手机在线接收。 */
export async function getCheckpointResults(
  transport: Transport,
  missionId: string,
): Promise<CheckpointEvidenceResult[]> {
  if (!missionId.trim()) throw new Error('任务 ID 不能为空');
  const raw = await transport.callService(
    MISSION_RESULTS_SERVICE,
    MISSION_RESULTS_SERVICE_TYPE,
    { mission_id: missionId },
  );
  const results = field(raw, 'results');
  return Array.isArray(results) ? results.map(normalizeCheckpointEvidence) : [];
}
