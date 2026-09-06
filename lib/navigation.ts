import {
  AUTONOMY_REQUEST_SOURCE,
  generateAutonomyRequestId,
  resolveMissionCommandSequence,
  toRosTime,
  type RosTime,
} from './autonomy-runtime';
import type { Subscription, Transport } from './transport';

export const NAVIGATION_SUBMIT_SERVICE = '/omni/mission/navigation/submit';
export const NAVIGATION_SUBMIT_SERVICE_TYPE =
  'omni_robot_interfaces/srv/SubmitNavigationGoal';
export const NAVIGATION_CANCEL_SERVICE = '/omni/mission/navigation/cancel';
export const NAVIGATION_CANCEL_SERVICE_TYPE =
  'omni_robot_interfaces/srv/CancelNavigationGoal';
export const NAVIGATION_STATUS_TOPIC = '/omni/mission/navigation/status';
export const NAVIGATION_STATUS_TYPE = 'omni_robot_interfaces/msg/NavigationStatus';

/** NavigationStatus.msg 与 NavigateToPose action 共享的状态编号。 */
export const NAVIGATION_STATE = {
  IDLE: 0,
  PREPARING: 1,
  PLANNING: 2,
  EXECUTING: 3,
  CANCELING: 4,
  SUCCEEDED: 5,
  CANCELED: 6,
  FAILED: 7,
  INTERRUPTED: 8,
} as const;

export const ACTIVE_NAVIGATION_STATES: readonly number[] = [
  NAVIGATION_STATE.PREPARING,
  NAVIGATION_STATE.PLANNING,
  NAVIGATION_STATE.EXECUTING,
  NAVIGATION_STATE.CANCELING,
];

export interface PoseStamped {
  header: {
    stamp: RosTime;
    frame_id: string;
  };
  pose: {
    position: { x: number; y: number; z: number };
    orientation: { x: number; y: number; z: number; w: number };
  };
}

export interface NavigationStatus {
  stamp: unknown;
  state: number;
  manager_epoch: string;
  status_sequence: number;
  operation_id: string;
  runtime_generation: number;
  request_id: string;
  request_sequence: number;
  request_source: string;
  requested_at: RosTime;
  deadline: RosTime;
  map_id: string;
  map_version: number;
  map_checksum: string;
  target_pose: PoseStamped;
  current_pose_valid: boolean;
  current_pose: PoseStamped;
  remaining_distance_m: number;
  reason_code: number;
  reason_text: string;
}

export interface SubmitNavigationGoalOptions {
  mapId: string;
  mapVersion: number;
  mapChecksum: string;
  targetPose: PoseStamped;
  requestId?: string;
  sequence?: number;
  source?: string;
  requestedAt?: RosTime;
  deadline?: RosTime;
  useFinalYaw?: boolean;
  speedScale?: number;
}

export interface SubmitNavigationGoalResponse {
  accepted: boolean;
  manager_epoch: string;
  operation_id: string;
  runtime_generation: number;
  reason_code: number;
  reason_text: string;
}

export interface CancelNavigationGoalOptions {
  targetOperationId: string;
  requestId?: string;
  sequence?: number;
  source?: string;
  requestedAt?: RosTime;
  deadline?: RosTime;
}

export interface CancelNavigationGoalResponse {
  accepted: boolean;
  manager_epoch: string;
  cancel_operation_id: string;
  reason_code: number;
  reason_text: string;
}

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

const ZERO_TIME: RosTime = { sec: 0, nanosec: 0 };

function normalizeTime(raw: unknown): RosTime {
  return {
    sec: asNumber(field(raw, 'sec')),
    nanosec: asNumber(field(raw, 'nanosec') ?? field(raw, 'nsec')),
  };
}

function emptyPose(): PoseStamped {
  return {
    header: { stamp: ZERO_TIME, frame_id: '' },
    pose: {
      position: { x: 0, y: 0, z: 0 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    },
  };
}

function normalizePoseStamped(raw: unknown): PoseStamped {
  const fallback = emptyPose();
  const header = field(raw, 'header') as any;
  const pose = field(raw, 'pose') as any;
  const position = field(pose, 'position') as any;
  const orientation = field(pose, 'orientation') as any;
  return {
    header: {
      stamp: normalizeTime(field(header, 'stamp')),
      frame_id: asString(field(header, 'frame_id')),
    },
    pose: {
      position: {
        x: asNumber(field(position, 'x')),
        y: asNumber(field(position, 'y')),
        z: asNumber(field(position, 'z')),
      },
      orientation: {
        x: asNumber(field(orientation, 'x')),
        y: asNumber(field(orientation, 'y')),
        z: asNumber(field(orientation, 'z')),
        w: asNumber(field(orientation, 'w'), fallback.pose.orientation.w),
      },
    },
  };
}

export function normalizeNavigationStatus(raw: any): NavigationStatus {
  return {
    stamp: field(raw, 'stamp') ?? null,
    state: asNumber(field(raw, 'state')),
    manager_epoch: asString(field(raw, 'manager_epoch')),
    status_sequence: asNumber(field(raw, 'status_sequence')),
    operation_id: asString(field(raw, 'operation_id')),
    runtime_generation: asNumber(field(raw, 'runtime_generation')),
    request_id: asString(field(raw, 'request_id')),
    request_sequence: asNumber(field(raw, 'request_sequence')),
    request_source: asString(field(raw, 'request_source')),
    requested_at: normalizeTime(field(raw, 'requested_at')),
    deadline: normalizeTime(field(raw, 'deadline')),
    map_id: asString(field(raw, 'map_id')),
    map_version: asNumber(field(raw, 'map_version')),
    map_checksum: asString(field(raw, 'map_checksum')),
    target_pose: normalizePoseStamped(field(raw, 'target_pose')),
    current_pose_valid: field(raw, 'current_pose_valid') === true,
    current_pose: normalizePoseStamped(field(raw, 'current_pose')),
    remaining_distance_m: asNumber(field(raw, 'remaining_distance_m')),
    reason_code: asNumber(field(raw, 'reason_code')),
    reason_text: asString(field(raw, 'reason_text')),
  };
}

export function isValidNavigationStatus(status: NavigationStatus): boolean {
  return status.manager_epoch !== '' &&
    Number.isInteger(status.status_sequence) && status.status_sequence > 0 &&
    Number.isInteger(status.state) && status.state >= NAVIGATION_STATE.IDLE &&
    status.state <= NAVIGATION_STATE.INTERRUPTED &&
    // 除空闲快照外，每个状态都必须能归属到一个明确 operation。
    (status.state === NAVIGATION_STATE.IDLE || status.operation_id !== '');
}

export function subscribeNavigationStatus(
  transport: Transport,
  callback: (status: NavigationStatus) => void,
): Subscription {
  return transport.subscribe(NAVIGATION_STATUS_TOPIC, NAVIGATION_STATUS_TYPE, (message) => {
    const status = normalizeNavigationStatus(message);
    if (isValidNavigationStatus(status)) callback(status);
  });
}

/** 地图交互层只产生坐标，本函数统一构造 Mission 可审计的 PoseStamped。 */
export function buildNavigationTargetPose(
  frameId: string,
  x: number,
  y: number,
  yaw = 0,
  stamp = toRosTime(Date.now()),
): PoseStamped {
  if (!frameId || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(yaw)) {
    throw new Error('Navigation target requires a valid frame and finite pose');
  }
  return {
    header: { stamp, frame_id: frameId.replace(/^\//, '') },
    pose: {
      position: { x, y, z: 0 },
      orientation: {
        x: 0,
        y: 0,
        z: Math.sin(yaw / 2),
        w: Math.cos(yaw / 2),
      },
    },
  };
}

export async function submitNavigationGoal(
  transport: Transport,
  options: SubmitNavigationGoalOptions,
): Promise<SubmitNavigationGoalResponse> {
  if (!options.mapId || !Number.isInteger(options.mapVersion) ||
      options.mapVersion <= 0 || !options.mapChecksum) {
    throw new Error('Navigation goal requires a complete map identity');
  }
  const position = options.targetPose?.pose?.position;
  const orientation = options.targetPose?.pose?.orientation;
  if (!options.targetPose?.header?.frame_id || !position || !orientation ||
      ![position.x, position.y, position.z, orientation.x, orientation.y,
        orientation.z, orientation.w].every(Number.isFinite)) {
    throw new Error('Navigation goal requires a finite PoseStamped in a named frame');
  }
  const speedScale = options.speedScale ?? 0;
  if (!Number.isFinite(speedScale) || speedScale < 0 || speedScale > 1 ||
      (speedScale > 0 && speedScale < 0.05)) {
    throw new Error('Navigation speed_scale must be 0 or between 0.05 and 1.0');
  }
  const nowMs = Date.now();
  const raw = await transport.callService(
    NAVIGATION_SUBMIT_SERVICE,
    NAVIGATION_SUBMIT_SERVICE_TYPE,
    {
      request_id: options.requestId ?? generateAutonomyRequestId('nav-goal'),
      sequence: resolveMissionCommandSequence(options.sequence),
      source: options.source ?? AUTONOMY_REQUEST_SOURCE,
      requested_at: options.requestedAt ?? toRosTime(nowMs),
      // 十分钟是业务执行上限；断线重放时 Mission 仍会拒绝已过期运动意图。
      deadline: options.deadline ?? toRosTime(nowMs + 10 * 60 * 1000),
      map_id: options.mapId,
      map_version: options.mapVersion,
      map_checksum: options.mapChecksum,
      target_pose: options.targetPose,
      use_final_yaw: options.useFinalYaw ?? false,
      speed_scale: speedScale,
    },
  );
  const wireAccepted = field(raw, 'accepted') === true;
  const managerEpoch = asString(field(raw, 'manager_epoch'));
  const operationId = asString(field(raw, 'operation_id'));
  const usable = !wireAccepted || (managerEpoch !== '' && operationId !== '');
  return {
    accepted: wireAccepted && usable,
    manager_epoch: managerEpoch,
    operation_id: operationId,
    runtime_generation: asNumber(field(raw, 'runtime_generation')),
    reason_code: asNumber(field(raw, 'reason_code')),
    reason_text: usable
      ? asString(field(raw, 'reason_text'))
      : 'Mission Manager accepted the navigation goal without operation identity',
  };
}

export async function cancelNavigationGoal(
  transport: Transport,
  options: CancelNavigationGoalOptions,
): Promise<CancelNavigationGoalResponse> {
  if (!options.targetOperationId) {
    throw new Error('Navigation cancel requires target_operation_id');
  }
  const nowMs = Date.now();
  const raw = await transport.callService(
    NAVIGATION_CANCEL_SERVICE,
    NAVIGATION_CANCEL_SERVICE_TYPE,
    {
      request_id: options.requestId ?? generateAutonomyRequestId('nav-cancel'),
      sequence: resolveMissionCommandSequence(options.sequence),
      source: options.source ?? AUTONOMY_REQUEST_SOURCE,
      requested_at: options.requestedAt ?? toRosTime(nowMs),
      deadline: options.deadline ?? toRosTime(nowMs + 30 * 1000),
      target_operation_id: options.targetOperationId,
    },
  );
  const wireAccepted = field(raw, 'accepted') === true;
  const managerEpoch = asString(field(raw, 'manager_epoch'));
  const cancelOperationId = asString(field(raw, 'cancel_operation_id'));
  const usable = !wireAccepted || (managerEpoch !== '' && cancelOperationId !== '');
  return {
    accepted: wireAccepted && usable,
    manager_epoch: managerEpoch,
    cancel_operation_id: cancelOperationId,
    reason_code: asNumber(field(raw, 'reason_code')),
    reason_text: usable
      ? asString(field(raw, 'reason_text'))
      : 'Mission Manager accepted cancellation without operation identity',
  };
}
