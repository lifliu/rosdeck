import type { Subscription, Transport } from './transport';

export const AUTONOMY_RUNTIME_STATUS_TOPIC = '/omni/mission/runtime/status';
export const AUTONOMY_RUNTIME_STATUS_TYPE =
  'omni_robot_interfaces/msg/AutonomyRuntimeStatus';
export const AUTONOMY_RUNTIME_SET_MODE_SERVICE =
  '/omni/mission/runtime/set_mode';
export const AUTONOMY_RUNTIME_SET_MODE_SERVICE_TYPE =
  'omni_robot_interfaces/srv/SetAutonomyMode';
export const AUTONOMY_RUNTIME_FINISH_MAPPING_SERVICE =
  '/omni/mission/runtime/finish_mapping';
export const AUTONOMY_RUNTIME_FINISH_MAPPING_SERVICE_TYPE =
  'omni_robot_interfaces/srv/FinishMapping';
export const AUTONOMY_RUNTIME_FINISH_ROUTE_RECORDING_SERVICE =
  '/omni/mission/runtime/finish_route_recording';
export const AUTONOMY_RUNTIME_FINISH_ROUTE_RECORDING_SERVICE_TYPE =
  'omni_robot_interfaces/srv/FinishRouteRecording';

/** AutonomyRuntimeStatus.msg 中固定的运行模式编号。 */
export const AUTONOMY_MODE = {
  IDLE: 0,
  MAPPING: 1,
  LOCALIZATION_READY: 2,
  SINGLE_POINT_READY: 3,
  INSPECTION_READY: 4,
  ROUTE_RECORDING: 5,
} as const;
export type AutonomyMode =
  (typeof AUTONOMY_MODE)[keyof typeof AUTONOMY_MODE];

/** AutonomyRuntimeStatus.msg 中固定的模式切换阶段。 */
export const AUTONOMY_PHASE = {
  IDLE: 0,
  STARTING: 1,
  READY: 2,
  SWITCHING: 3,
  STOPPING: 4,
  ERROR: 5,
  CONFLICT: 6,
} as const;
export type AutonomyPhase =
  (typeof AUTONOMY_PHASE)[keyof typeof AUTONOMY_PHASE];

/** FinishMapping.srv 的地图处置方式。 */
export const MAPPING_DISPOSITION = {
  SAVE: 1,
  DISCARD: 2,
} as const;
export type MappingDisposition =
  (typeof MAPPING_DISPOSITION)[keyof typeof MAPPING_DISPOSITION];

/** FinishRouteRecording.srv 的路线处置方式。 */
export const ROUTE_RECORDING_DISPOSITION = {
  SAVE: 1,
  DISCARD: 2,
} as const;
export type RouteRecordingDisposition =
  (typeof ROUTE_RECORDING_DISPOSITION)[keyof typeof ROUTE_RECORDING_DISPOSITION];

/** ROS 2 builtin_interfaces/Time 在线路上的字段形状。 */
export interface RosTime {
  sec: number;
  nanosec: number;
}

export interface MissionRequestEnvelope {
  requestId: string;
  sequence: number;
  source: string;
  requestedAt: RosTime;
  deadline: RosTime;
}

export interface AutonomyRuntimeStatus {
  stamp: unknown;
  desired_mode: number;
  mode: number;
  phase: number;
  slam_state: number;
  planner_state: number;
  route_recording_state: number;
  ready: boolean;
  mission_active: boolean;
  manager_epoch: string;
  runtime_generation: number;
  status_sequence: number;
  operation_id: string;
  request_id: string;
  request_sequence: number;
  request_source: string;
  map_id: string;
  map_version: number;
  map_checksum: string;
  reason_code: number;
  reason_text: string;
  route_id: string;
  route_point_count: number;
  route_distance_m: number;
  route_checksum: string;
  route_has_unsaved_data: boolean;
  recording_operation_id: string;
}

export interface AutonomyCommandResponse {
  accepted: boolean;
  operation_id: string;
  reason_code: number;
  reason_text: string;
  runtime_generation: number;
}

export interface SetAutonomyModeOptions {
  desiredMode: AutonomyMode;
  requestId?: string;
  sequence?: number;
  source?: string;
  mapId?: string;
  mapVersion?: number;
  mappingSessionId?: string;
  initialX?: number;
  initialY?: number;
  initialZ?: number;
  initialYaw?: number;
  timeoutSec?: number;
  requestedAt?: RosTime;
  deadline?: RosTime;
  mapChecksum?: string;
  routeId?: string;
}

export interface FinishMappingOptions {
  disposition: MappingDisposition;
  requestId?: string;
  sequence?: number;
  source?: string;
  mapId?: string;
  calibrationHash?: string;
  makeCurrent?: boolean;
  requestedAt?: RosTime;
  deadline?: RosTime;
}

export interface FinishRouteRecordingOptions {
  disposition: RouteRecordingDisposition;
  recordingOperationId: string;
  requestId?: string;
  sequence?: number;
  source?: string;
  requestedAt?: RosTime;
  deadline?: RosTime;
}

// 每次 APP 进程使用独立且稳定的 source，避免重启后从 sequence=1 开始时被
// Manager 当成旧请求；同一进程内的 sequence 则严格单调递增。
export const AUTONOMY_REQUEST_SOURCE = `app:omni_deck:${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 10)
  .padEnd(8, '0')}`;
let requestIdSequence = 0;
let commandSequence = 0;

function field(obj: any, name: string): unknown {
  const camel = name.replace(/_([a-z])/g, (_match, character: string) =>
    character.toUpperCase());
  return obj?.[name] ?? obj?.[camel];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // uint64 在不同 WS 实现中可能被解码为 bigint 或十进制字符串。
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

/**
 * Foxglove 保留 IDL 的 snake_case；camelCase 回退仅用于兼容会重写字段名的
 * rosbridge 网关。所有 UI 只消费该规范化结果，避免每个按钮各自解释线协议。
 */
export function normalizeAutonomyRuntimeStatus(raw: any): AutonomyRuntimeStatus {
  return {
    stamp: field(raw, 'stamp') ?? null,
    desired_mode: asNumber(field(raw, 'desired_mode')),
    mode: asNumber(field(raw, 'mode')),
    phase: asNumber(field(raw, 'phase')),
    slam_state: asNumber(field(raw, 'slam_state')),
    planner_state: asNumber(field(raw, 'planner_state')),
    route_recording_state: asNumber(field(raw, 'route_recording_state')),
    ready: asBool(field(raw, 'ready')),
    mission_active: asBool(field(raw, 'mission_active')),
    manager_epoch: asString(field(raw, 'manager_epoch')),
    runtime_generation: asNumber(field(raw, 'runtime_generation')),
    status_sequence: asNumber(field(raw, 'status_sequence')),
    operation_id: asString(field(raw, 'operation_id')),
    request_id: asString(field(raw, 'request_id')),
    request_sequence: asNumber(field(raw, 'request_sequence')),
    request_source: asString(field(raw, 'request_source')),
    map_id: asString(field(raw, 'map_id')),
    map_version: asNumber(field(raw, 'map_version')),
    map_checksum: asString(field(raw, 'map_checksum')),
    reason_code: asNumber(field(raw, 'reason_code')),
    reason_text: asString(field(raw, 'reason_text')),
    route_id: asString(field(raw, 'route_id')),
    route_point_count: asNumber(field(raw, 'route_point_count')),
    route_distance_m: asNumber(field(raw, 'route_distance_m')),
    route_checksum: asString(field(raw, 'route_checksum')),
    route_has_unsaved_data: asBool(field(raw, 'route_has_unsaved_data')),
    recording_operation_id: asString(field(raw, 'recording_operation_id')),
  };
}

/** 拒绝缺少权威身份或携带越界枚举的快照，避免畸形消息把按钮误判为 IDLE。 */
export function isValidAutonomyRuntimeStatus(status: AutonomyRuntimeStatus): boolean {
  return status.manager_epoch !== '' &&
    Number.isInteger(status.status_sequence) && status.status_sequence > 0 &&
    Number.isInteger(status.mode) && status.mode >= AUTONOMY_MODE.IDLE &&
    status.mode <= AUTONOMY_MODE.ROUTE_RECORDING &&
    Number.isInteger(status.desired_mode) && status.desired_mode >= AUTONOMY_MODE.IDLE &&
    status.desired_mode <= AUTONOMY_MODE.ROUTE_RECORDING &&
    Number.isInteger(status.phase) && status.phase >= AUTONOMY_PHASE.IDLE &&
    status.phase <= AUTONOMY_PHASE.CONFLICT;
}

function normalizeCommandResponse(raw: any): AutonomyCommandResponse {
  const wireAccepted = asBool(field(raw, 'accepted'));
  const operationId = asString(field(raw, 'operation_id'));
  const responseIsUsable = !wireAccepted || operationId !== '';
  return {
    // accepted 的异步请求必须携带 operation_id，否则客户端无法确认最终态。
    accepted: wireAccepted && responseIsUsable,
    operation_id: operationId,
    reason_code: asNumber(field(raw, 'reason_code')),
    reason_text: responseIsUsable
      ? asString(field(raw, 'reason_text'))
      : 'Mission Manager accepted the request without operation_id',
    runtime_generation: asNumber(field(raw, 'runtime_generation')),
  };
}

/** 为每次用户意图生成幂等键；同一请求重试时可由调用方显式复用 requestId。 */
export function generateAutonomyRequestId(prefix = 'runtime'): string {
  requestIdSequence = (requestIdSequence + 1) % 1296;
  return `${prefix}-${Date.now().toString(36)}-${requestIdSequence
    .toString(36)
    .padStart(2, '0')}`;
}

/** 生成可读且低碰撞的默认地图 ID，供没有地图命名表单的快捷建图入口使用。 */
export function generateMappingMapId(now = new Date()): string {
  const timestamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const suffix = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `map-${timestamp}-${suffix}`;
}

/** 地图 ID 会成为机器人端目录名，只允许 MapStore 支持的可移植字符集合。 */
export function isValidMapId(mapId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(mapId);
}

/** 生成可直接用作文件资产键的默认路线 ID。 */
export function generateRouteId(now = new Date()): string {
  // 保留毫秒，连续完成并立即开始下一次录制时也不会复用刚保存的资产键。
  return `route-${now.toISOString().replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1Z')}`;
}

export function nextMissionCommandSequence(): number {
  commandSequence += 1;
  return commandSequence;
}

export function resolveMissionCommandSequence(explicit?: number): number {
  if (explicit === undefined) return nextMissionCommandSequence();
  // 调用方若为重试显式复用 sequence，后续自动编号仍必须保持向前推进。
  commandSequence = Math.max(commandSequence, explicit);
  return explicit;
}

/** 把 JavaScript 毫秒时间转换为 ROS 2 Time，避免各业务接口重复实现取整。 */
export function toRosTime(epochMs: number): RosTime {
  if (!Number.isFinite(epochMs) || epochMs < 0) {
    throw new Error('ROS time requires a finite non-negative epoch');
  }
  const wholeMs = Math.floor(epochMs);
  return {
    sec: Math.floor(wholeMs / 1000),
    nanosec: (wholeMs % 1000) * 1_000_000,
  };
}

/**
 * 为 Mission 业务请求生成统一信封。同一请求重试必须复用返回对象，不能只复用
 * request_id 却重新分配 sequence 或 deadline。
 */
export function createMissionRequestEnvelope(
  prefix: string,
  ttlSec: number,
  nowMs = Date.now(),
): MissionRequestEnvelope {
  if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
    throw new Error('Mission request ttlSec must be positive');
  }
  return {
    requestId: generateAutonomyRequestId(prefix),
    sequence: nextMissionCommandSequence(),
    source: AUTONOMY_REQUEST_SOURCE,
    requestedAt: toRosTime(nowMs),
    deadline: toRosTime(nowMs + ttlSec * 1000),
  };
}

function resolveTiming(
  requestedAt: RosTime | undefined,
  deadline: RosTime | undefined,
  defaultTtlSec: number,
): { requestedAt: RosTime; deadline: RosTime } {
  const nowMs = Date.now();
  return {
    requestedAt: requestedAt ?? toRosTime(nowMs),
    deadline: deadline ?? toRosTime(nowMs + defaultTtlSec * 1000),
  };
}

export function subscribeAutonomyRuntimeStatus(
  transport: Transport,
  callback: (status: AutonomyRuntimeStatus) => void,
): Subscription {
  return transport.subscribe(
    AUTONOMY_RUNTIME_STATUS_TOPIC,
    AUTONOMY_RUNTIME_STATUS_TYPE,
    (message) => {
      const status = normalizeAutonomyRuntimeStatus(message);
      if (isValidAutonomyRuntimeStatus(status)) callback(status);
    },
  );
}

/** 请求 Mission Manager 确保目标运行模式，不直接启动或停止机器人端进程。 */
export async function setAutonomyMode(
  transport: Transport,
  options: SetAutonomyModeOptions,
): Promise<AutonomyCommandResponse> {
  if (options.desiredMode === AUTONOMY_MODE.MAPPING && !options.mappingSessionId) {
    throw new Error('MODE_MAPPING requires mapping_session_id');
  }
  if (options.desiredMode === AUTONOMY_MODE.ROUTE_RECORDING && !options.routeId) {
    throw new Error('MODE_ROUTE_RECORDING requires route_id');
  }
  if ((options.desiredMode === AUTONOMY_MODE.SINGLE_POINT_READY ||
       options.desiredMode === AUTONOMY_MODE.ROUTE_RECORDING) &&
      (!options.mapId || !Number.isInteger(options.mapVersion) ||
       (options.mapVersion ?? 0) <= 0 || !options.mapChecksum)) {
    throw new Error('Selected autonomy mode requires a complete map identity');
  }
  const timing = resolveTiming(options.requestedAt, options.deadline, 120);
  const raw = await transport.callService(
    AUTONOMY_RUNTIME_SET_MODE_SERVICE,
    AUTONOMY_RUNTIME_SET_MODE_SERVICE_TYPE,
    {
      request_id: options.requestId ?? generateAutonomyRequestId('mode'),
      sequence: resolveMissionCommandSequence(options.sequence),
      source: options.source ?? AUTONOMY_REQUEST_SOURCE,
      desired_mode: options.desiredMode,
      map_id: options.mapId ?? '',
      map_version: options.mapVersion ?? 0,
      mapping_session_id: options.desiredMode === AUTONOMY_MODE.MAPPING
        ? options.mappingSessionId
        : '',
      initial_x: options.initialX ?? 0,
      initial_y: options.initialY ?? 0,
      initial_z: options.initialZ ?? 0,
      initial_yaw: options.initialYaw ?? 0,
      // 0 表示使用机器人端部署默认值，移动端不重复维护进程启动超时。
      timeout_sec: options.timeoutSec ?? 0,
      requested_at: timing.requestedAt,
      deadline: timing.deadline,
      map_checksum: options.mapChecksum ?? '',
      route_id: options.desiredMode === AUTONOMY_MODE.ROUTE_RECORDING
        ? options.routeId ?? ''
        : '',
    },
  );
  return normalizeCommandResponse(raw);
}

/** 建图结束必须明确保存或丢弃，不能用“停止”隐式决定地图是否落盘。 */
export async function finishMapping(
  transport: Transport,
  options: FinishMappingOptions,
): Promise<AutonomyCommandResponse> {
  if (options.disposition !== MAPPING_DISPOSITION.SAVE &&
      options.disposition !== MAPPING_DISPOSITION.DISCARD) {
    throw new Error('FinishMapping requires an explicit SAVE or DISCARD disposition');
  }
  if (options.disposition === MAPPING_DISPOSITION.SAVE && !options.mapId) {
    throw new Error('SAVE requires map_id');
  }
  const timing = resolveTiming(options.requestedAt, options.deadline, 120);
  const raw = await transport.callService(
    AUTONOMY_RUNTIME_FINISH_MAPPING_SERVICE,
    AUTONOMY_RUNTIME_FINISH_MAPPING_SERVICE_TYPE,
    {
      request_id: options.requestId ?? generateAutonomyRequestId('mapping'),
      sequence: resolveMissionCommandSequence(options.sequence),
      source: options.source ?? AUTONOMY_REQUEST_SOURCE,
      disposition: options.disposition,
      // DISCARD 的三个资产字段按 IDL 必须为空/false，调用方无法误带旧地图 ID。
      map_id: options.disposition === MAPPING_DISPOSITION.SAVE ? options.mapId ?? '' : '',
      calibration_hash: options.disposition === MAPPING_DISPOSITION.SAVE
        ? options.calibrationHash ?? ''
        : '',
      make_current: options.disposition === MAPPING_DISPOSITION.SAVE
        ? options.makeCurrent ?? true
        : false,
      requested_at: timing.requestedAt,
      deadline: timing.deadline,
    },
  );
  return normalizeCommandResponse(raw);
}

/** 路线录制只能用显式 SAVE/DISCARD 结束，并绑定当前录制 operation。 */
export async function finishRouteRecording(
  transport: Transport,
  options: FinishRouteRecordingOptions,
): Promise<AutonomyCommandResponse> {
  if (options.disposition !== ROUTE_RECORDING_DISPOSITION.SAVE &&
      options.disposition !== ROUTE_RECORDING_DISPOSITION.DISCARD) {
    throw new Error('FinishRouteRecording requires an explicit SAVE or DISCARD disposition');
  }
  if (!options.recordingOperationId) {
    throw new Error('FinishRouteRecording requires recording_operation_id');
  }
  const timing = resolveTiming(options.requestedAt, options.deadline, 120);
  const raw = await transport.callService(
    AUTONOMY_RUNTIME_FINISH_ROUTE_RECORDING_SERVICE,
    AUTONOMY_RUNTIME_FINISH_ROUTE_RECORDING_SERVICE_TYPE,
    {
      request_id: options.requestId ?? generateAutonomyRequestId('route-finish'),
      sequence: resolveMissionCommandSequence(options.sequence),
      source: options.source ?? AUTONOMY_REQUEST_SOURCE,
      requested_at: timing.requestedAt,
      deadline: timing.deadline,
      recording_operation_id: options.recordingOperationId,
      disposition: options.disposition,
    },
  );
  return normalizeCommandResponse(raw);
}
