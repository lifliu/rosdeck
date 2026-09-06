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
  type DispatchResponse,
  type MissionControlCmd,
  type RouteEntry,
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

export const MISSION_STATUS_TOPIC = '/omni/mission/status';
export const MISSION_STATUS_TYPE = 'omni_robot_interfaces/msg/MissionStatus';
export const MISSION_EVENTS_TOPIC = '/omni/mission/events';
export const MISSION_EVENTS_TYPE = 'omni_robot_interfaces/msg/MissionEvent';
export const ROBOT_STATE_TOPIC = '/omni/robot_state';
export const ROBOT_STATE_TYPE = 'omni_robot_interfaces/msg/RobotState';
export const DEFAULT_INSPECTION_DEADLINE_MS = 30 * 60 * 1000;

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
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
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
  return values.map((v) => typeof v === 'number' && Number.isFinite(v) ? v : 0);
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
