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
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
}

export async function dispatchMission(
  transport: Transport,
  options: DispatchOptions,
): Promise<DispatchResponse> {
  const raw = await transport.callService(
    MISSION_DISPATCH_SERVICE,
    MISSION_DISPATCH_SERVICE_TYPE,
    {
      mission_id: options.missionId ?? '',
      request_id: options.requestId,
      sequence: options.sequence ?? 1,
      map_id: options.mapId ?? '',
      map_version: options.mapVersion ?? '',
      route_id: options.routeId,
      checkpoint_ids: [],
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
  return routeIds.map((routeId, i) => ({
    routeId,
    mapId: mapIds[i] ?? '',
    frameId: frameIds[i] ?? '',
    createdAt: createdAt[i] ?? '',
  }));
}