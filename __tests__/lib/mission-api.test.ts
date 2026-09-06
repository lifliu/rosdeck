import {
  DEFAULT_INSPECTION_COMMAND_TTL_SEC,
  MISSION_CONTROL_SERVICE,
  MISSION_CONTROL_SERVICE_TYPE,
  MISSION_DISPATCH_SERVICE,
  MISSION_DISPATCH_SERVICE_TYPE,
  MISSION_LIST_ROUTES_SERVICE,
  MISSION_LIST_ROUTES_SERVICE_TYPE,
  cancelMission,
  dispatchMission,
  generateRequestId,
  listRoutes,
  pauseMission,
  resumeMission,
} from '../../lib/mission/api';
import { MISSION_CONTROL_CMD } from '../../lib/mission/types';
import type { Transport } from '../../lib/transport';
import { getLocalServiceSchema } from '../../lib/ros-service-schemas';
import { parse as parseMessageDefinition } from '@foxglove/rosmsg';
import { MessageWriter } from '@foxglove/rosmsg2-serialization';

interface Call {
  service: string;
  serviceType: string;
  request: Record<string, unknown>;
}

function makeTransport(
  respond: (request: Record<string, unknown>) => Record<string, unknown>,
) {
  const calls: Call[] = [];
  const transport: Transport = {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
    subscribe: jest.fn().mockReturnValue({ unsubscribe: jest.fn() }),
    publish: jest.fn(),
    callService: jest.fn(async (service, serviceType, request) => {
      calls.push({ service, serviceType, request });
      return respond(request);
    }),
    getTopics: jest.fn().mockResolvedValue([]),
    onStatus: jest.fn().mockReturnValue(jest.fn()),
    getStatus: jest.fn().mockReturnValue('connected'),
  };
  return { transport, calls };
}

describe('generateRequestId', () => {
  it('matches the app-<ts>-<seq> shape', () => {
    expect(generateRequestId()).toMatch(/^app-[0-9a-z]+-[0-9a-z]{2}$/);
  });

  it('is unique across many calls (sequence rolls under 36^2)', () => {
    const ids = new Set(Array.from({ length: 500 }, () => generateRequestId()));
    expect(ids.size).toBe(500);
  });
});

describe('dispatchMission', () => {
  it('sends the V1 request with snake_case fields and empty checkpoints', async () => {
    const { transport, calls } = makeTransport(() => ({
      accepted: true,
      reason_code: 0,
      reason_text: '',
      mission_id: 'm20260817-001',
    }));
    const res = await dispatchMission(transport, {
      routeId: 'route-a',
      requestId: 'app-xyz-01',
      sequence: 7,
      source: 'test-app',
      requestedAt: { sec: 100, nanosec: 0 },
      deadline: { sec: 130, nanosec: 0 },
      mapId: 'map-a',
      mapVersion: '2',
      mapChecksum: 'map-sha',
      routeChecksum: 'route-sha',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].service).toBe(MISSION_DISPATCH_SERVICE);
    expect(calls[0].serviceType).toBe(MISSION_DISPATCH_SERVICE_TYPE);
    expect(calls[0].request).toEqual({
      mission_id: '',
      request_id: 'app-xyz-01',
      sequence: 7,
      map_id: 'map-a',
      map_version: '2',
      route_id: 'route-a',
      checkpoint_ids: [],
      source: 'test-app',
      requested_at: { sec: 100, nanosec: 0 },
      deadline: { sec: 130, nanosec: 0 },
      map_checksum: 'map-sha',
      route_checksum: 'route-sha',
    });
    expect(res).toEqual({
      accepted: true,
      reason_code: 0,
      reason_text: '',
      mission_id: 'm20260817-001',
    });
    const schema = getLocalServiceSchema(MISSION_DISPATCH_SERVICE_TYPE, 'request');
    const writer = new MessageWriter(parseMessageDefinition(schema!, { ros2: true }));
    expect(() => writer.writeMessage(calls[0].request)).not.toThrow();
  });

  it('honors explicit sequence / map overrides', async () => {
    const { transport, calls } = makeTransport(() => ({
      accepted: true,
      reason_code: 0,
      reason_text: '',
      mission_id: '',
    }));
    await dispatchMission(transport, {
      routeId: 'r',
      requestId: 'req',
      sequence: 2,
      mapId: 'map-1',
      mapVersion: 'v3',
    });
    expect(calls[0].request).toMatchObject({
      sequence: 2,
      map_id: 'map-1',
      map_version: 'v3',
    });
  });

  it('uses an execution-sized default deadline instead of a network timeout', async () => {
    expect(DEFAULT_INSPECTION_COMMAND_TTL_SEC).toBe(30 * 60);
    jest.spyOn(Date, 'now').mockReturnValue(100_000);
    const { transport, calls } = makeTransport(() => ({ accepted: false }));
    await dispatchMission(transport, { routeId: 'r', requestId: 'req-default' });
    expect(calls[0].request).toMatchObject({
      requested_at: { sec: 100, nanosec: 0 },
      deadline: { sec: 1900, nanosec: 0 },
    });
    jest.restoreAllMocks();
  });

  it('falls back to camelCase fields when a bridge re-cases the response', async () => {
    const { transport } = makeTransport(() => ({
      accepted: false,
      reasonCode: 3,
      reasonText: 'route not found',
      missionId: '',
    }));
    const res = await dispatchMission(transport, {
      routeId: 'r',
      requestId: 'req',
    });
    expect(res).toEqual({
      accepted: false,
      reason_code: 3,
      reason_text: 'route not found',
      mission_id: '',
    });
  });
});

describe('control wrappers', () => {
  it.each([
    ['pause', pauseMission, MISSION_CONTROL_CMD.PAUSE],
    ['resume', resumeMission, MISSION_CONTROL_CMD.RESUME],
    ['cancel', cancelMission, MISSION_CONTROL_CMD.CANCEL],
  ] as const)('%s sends command=%d with a fresh request_id', async (name, fn, cmd) => {
    const { transport, calls } = makeTransport(() => ({
      accepted: true,
      reason_code: 0,
      reason_text: '',
    }));
    const res = await fn(transport, 'm1');
    expect(calls).toHaveLength(1);
    expect(calls[0].service).toBe(MISSION_CONTROL_SERVICE);
    expect(calls[0].serviceType).toBe(MISSION_CONTROL_SERVICE_TYPE);
    expect(calls[0].request).toMatchObject({
      command: cmd,
      mission_id: 'm1',
      sequence: 1,
    });
    expect(calls[0].request.request_id).toMatch(/^app-/);
    expect(res.accepted).toBe(true);
  });

  it('defaults mission_id to empty (the active mission) and request ids differ per call', async () => {
    const { transport, calls } = makeTransport(() => ({
      accepted: true,
      reason_code: 0,
      reason_text: '',
    }));
    await cancelMission(transport);
    await cancelMission(transport);
    expect(calls[0].request.mission_id).toBe('');
    expect(calls[0].request.request_id).not.toBe(calls[1].request.request_id);
  });
});

describe('listRoutes', () => {
  it('zips the parallel arrays into RouteEntry objects', async () => {
    const { transport, calls } = makeTransport(() => ({
      route_ids: ['a', 'b'],
      map_ids: ['m1', 'm2'],
      frame_ids: ['base_link', ''],
      created_at: ['2026-01-01T00:00:00Z', ''],
      map_versions: ['3', '4'],
      map_checksums: ['map-sha-1', 'map-sha-2'],
      route_checksums: ['route-sha-1', 'route-sha-2'],
      point_counts: new Uint32Array([12, 4]),
      distances_m: new Float32Array([8.5, 2.25]),
    }));
    const routes = await listRoutes(transport);
    expect(calls[0].service).toBe(MISSION_LIST_ROUTES_SERVICE);
    expect(routes).toEqual([
      {
        routeId: 'a', mapId: 'm1', frameId: 'base_link',
        createdAt: '2026-01-01T00:00:00Z', mapVersion: '3',
        mapChecksum: 'map-sha-1', routeChecksum: 'route-sha-1',
        pointCount: 12, distanceM: 8.5,
      },
      {
        routeId: 'b', mapId: 'm2', frameId: '', createdAt: '', mapVersion: '4',
        mapChecksum: 'map-sha-2', routeChecksum: 'route-sha-2',
        pointCount: 4, distanceM: 2.25,
      },
    ]);
  });

  it('tolerates a shorter side array', async () => {
    const { transport } = makeTransport(() => ({
      route_ids: ['a', 'b', 'c'],
      map_ids: ['m1'],
      frame_ids: [],
      created_at: [],
    }));
    const routes = await listRoutes(transport);
    expect(routes).toHaveLength(3);
    expect(routes[0].mapId).toBe('m1');
    expect(routes[2].mapId).toBe('');
    expect(routes[2].frameId).toBe('');
  });

  it('returns [] when the response has no route_ids', async () => {
    const { transport } = makeTransport(() => ({}));
    await expect(listRoutes(transport)).resolves.toEqual([]);
  });
});
