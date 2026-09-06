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
}

export interface FinishMappingOptions {
  disposition: MappingDisposition;
  requestId?: string;
  sequence?: number;
  source?: string;
  mapId?: string;
  calibrationHash?: string;
  makeCurrent?: boolean;
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

function nextCommandSequence(): number {
  commandSequence += 1;
  return commandSequence;
}

function resolveCommandSequence(explicit?: number): number {
  if (explicit === undefined) return nextCommandSequence();
  // 调用方若为重试显式复用 sequence，后续自动编号仍必须保持向前推进。
  commandSequence = Math.max(commandSequence, explicit);
  return explicit;
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
  const raw = await transport.callService(
    AUTONOMY_RUNTIME_SET_MODE_SERVICE,
    AUTONOMY_RUNTIME_SET_MODE_SERVICE_TYPE,
    {
      request_id: options.requestId ?? generateAutonomyRequestId('mode'),
      sequence: resolveCommandSequence(options.sequence),
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
  const raw = await transport.callService(
    AUTONOMY_RUNTIME_FINISH_MAPPING_SERVICE,
    AUTONOMY_RUNTIME_FINISH_MAPPING_SERVICE_TYPE,
    {
      request_id: options.requestId ?? generateAutonomyRequestId('mapping'),
      sequence: resolveCommandSequence(options.sequence),
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
    },
  );
  return normalizeCommandResponse(raw);
}
