import {
  AUTONOMY_MODE,
  AUTONOMY_PHASE,
  AUTONOMY_RUNTIME_FINISH_MAPPING_SERVICE,
  AUTONOMY_RUNTIME_FINISH_MAPPING_SERVICE_TYPE,
  AUTONOMY_RUNTIME_FINISH_ROUTE_RECORDING_SERVICE,
  AUTONOMY_RUNTIME_FINISH_ROUTE_RECORDING_SERVICE_TYPE,
  AUTONOMY_RUNTIME_SET_MODE_SERVICE,
  AUTONOMY_RUNTIME_SET_MODE_SERVICE_TYPE,
  AUTONOMY_RUNTIME_STATUS_TOPIC,
  AUTONOMY_RUNTIME_STATUS_TYPE,
  MAPPING_DISPOSITION,
  ROUTE_RECORDING_DISPOSITION,
  createMissionRequestEnvelope,
  finishMapping,
  finishRouteRecording,
  generateMappingMapId,
  isValidMapId,
  isValidAutonomyRuntimeStatus,
  normalizeAutonomyRuntimeStatus,
  setAutonomyMode,
  subscribeAutonomyRuntimeStatus,
} from '../../lib/autonomy-runtime';
import type { Transport } from '../../lib/transport';
import { getLocalServiceSchema } from '../../lib/ros-service-schemas';
import { parse as parseMessageDefinition } from '@foxglove/rosmsg';
import { MessageWriter } from '@foxglove/rosmsg2-serialization';

function makeTransport(response: Record<string, unknown> = {}) {
  let topicCallback: ((message: any) => void) | null = null;
  const transport: Transport = {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
    subscribe: jest.fn((_topic, _type, callback) => {
      topicCallback = callback;
      return { unsubscribe: jest.fn() };
    }),
    publish: jest.fn(),
    callService: jest.fn().mockResolvedValue(response),
    getTopics: jest.fn().mockResolvedValue([]),
    onStatus: jest.fn().mockReturnValue(jest.fn()),
    getStatus: jest.fn().mockReturnValue('connected'),
  };
  return {
    transport,
    emit: (message: any) => topicCallback?.(message),
  };
}

describe('autonomy runtime contract', () => {
  it('pins the IDL mode and phase constants used by the APP', () => {
    expect(AUTONOMY_MODE).toEqual({
      IDLE: 0,
      MAPPING: 1,
      LOCALIZATION_READY: 2,
      SINGLE_POINT_READY: 3,
      INSPECTION_READY: 4,
      ROUTE_RECORDING: 5,
    });
    expect(AUTONOMY_PHASE).toEqual({
      IDLE: 0,
      STARTING: 1,
      READY: 2,
      SWITCHING: 3,
      STOPPING: 4,
      ERROR: 5,
      CONFLICT: 6,
    });
  });

  it('registers Humble Foxglove CDR fallbacks for all runtime services', () => {
    expect(getLocalServiceSchema(
      AUTONOMY_RUNTIME_SET_MODE_SERVICE_TYPE,
      'request',
    )).toContain('uint8 desired_mode');
    expect(getLocalServiceSchema(
      AUTONOMY_RUNTIME_FINISH_MAPPING_SERVICE_TYPE,
      'request',
    )).toContain('uint8 disposition');
    expect(getLocalServiceSchema(
      AUTONOMY_RUNTIME_FINISH_MAPPING_SERVICE_TYPE,
      'response',
    )).toContain('uint64 runtime_generation');
    expect(getLocalServiceSchema(
      AUTONOMY_RUNTIME_FINISH_ROUTE_RECORDING_SERVICE_TYPE,
      'request',
    )).toContain('string recording_operation_id');

    const setModeWriter = new MessageWriter(parseMessageDefinition(getLocalServiceSchema(
      AUTONOMY_RUNTIME_SET_MODE_SERVICE_TYPE,
      'request',
    )!, { ros2: true }));
    expect(() => setModeWriter.writeMessage({
      request_id: 'mode-1',
      sequence: 1,
      source: 'test-app',
      desired_mode: AUTONOMY_MODE.SINGLE_POINT_READY,
      map_id: 'map-a',
      map_version: 1,
      mapping_session_id: '',
      initial_x: 0,
      initial_y: 0,
      initial_z: 0,
      initial_yaw: 0,
      timeout_sec: 0,
      requested_at: { sec: 1, nanosec: 0 },
      deadline: { sec: 31, nanosec: 0 },
      map_checksum: 'map-sha',
      route_id: '',
    })).not.toThrow();
  });

  it('subscribes to the Mission Manager status and normalizes bridge field casing', () => {
    const { transport, emit } = makeTransport();
    const callback = jest.fn();
    subscribeAutonomyRuntimeStatus(transport, callback);

    expect(transport.subscribe).toHaveBeenCalledWith(
      AUTONOMY_RUNTIME_STATUS_TOPIC,
      AUTONOMY_RUNTIME_STATUS_TYPE,
      expect.any(Function),
    );
    emit({
      desiredMode: AUTONOMY_MODE.SINGLE_POINT_READY,
      mode: AUTONOMY_MODE.LOCALIZATION_READY,
      phase: AUTONOMY_PHASE.SWITCHING,
      runtimeGeneration: 7,
      managerEpoch: 'epoch-7',
      statusSequence: '12',
      requestSequence: 3n,
      reasonText: 'preparing planner',
      routeId: 'route-a',
      routePointCount: '12',
      routeDistanceM: 8.5,
      routeHasUnsavedData: true,
      recordingOperationId: 'record-route-7',
    });
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      desired_mode: AUTONOMY_MODE.SINGLE_POINT_READY,
      mode: AUTONOMY_MODE.LOCALIZATION_READY,
      phase: AUTONOMY_PHASE.SWITCHING,
      runtime_generation: 7,
      manager_epoch: 'epoch-7',
      status_sequence: 12,
      request_sequence: 3,
      reason_text: 'preparing planner',
      route_id: 'route-a',
      route_point_count: 12,
      route_distance_m: 8.5,
      route_has_unsaved_data: true,
      recording_operation_id: 'record-route-7',
    }));
  });

  it('does not synchronize the UI from a malformed empty snapshot', () => {
    const { transport, emit } = makeTransport();
    const callback = jest.fn();
    subscribeAutonomyRuntimeStatus(transport, callback);
    emit({});
    expect(callback).not.toHaveBeenCalled();
    expect(isValidAutonomyRuntimeStatus(normalizeAutonomyRuntimeStatus({}))).toBe(false);
  });

  it('sends a complete SetAutonomyMode request to Mission Manager', async () => {
    const { transport } = makeTransport({
      accepted: true,
      operation_id: 'op-1',
      reason_code: 0,
      reason_text: '',
      runtime_generation: 8,
    });
    const response = await setAutonomyMode(transport, {
      requestId: 'req-1',
      sequence: 4,
      source: 'test-app',
      desiredMode: AUTONOMY_MODE.MAPPING,
      mapId: 'map-a',
      mapVersion: 2,
      mappingSessionId: 'session-a',
      initialX: 1,
      initialY: 2,
      initialZ: 3,
      initialYaw: 0.5,
      timeoutSec: 30,
      requestedAt: { sec: 100, nanosec: 1 },
      deadline: { sec: 130, nanosec: 1 },
      mapChecksum: 'sha256:map-a',
    });

    expect(transport.callService).toHaveBeenCalledWith(
      AUTONOMY_RUNTIME_SET_MODE_SERVICE,
      AUTONOMY_RUNTIME_SET_MODE_SERVICE_TYPE,
      {
        request_id: 'req-1',
        sequence: 4,
        source: 'test-app',
        desired_mode: AUTONOMY_MODE.MAPPING,
        map_id: 'map-a',
        map_version: 2,
        mapping_session_id: 'session-a',
        initial_x: 1,
        initial_y: 2,
        initial_z: 3,
        initial_yaw: 0.5,
        timeout_sec: 30,
        requested_at: { sec: 100, nanosec: 1 },
        deadline: { sec: 130, nanosec: 1 },
        map_checksum: 'sha256:map-a',
        route_id: '',
      },
    );
    expect(response).toEqual({
      accepted: true,
      operation_id: 'op-1',
      reason_code: 0,
      reason_text: '',
      runtime_generation: 8,
    });
  });

  it('rejects an invalid mapping request before sending CDR', async () => {
    const { transport } = makeTransport();
    await expect(setAutonomyMode(transport, {
      desiredMode: AUTONOMY_MODE.MAPPING,
    })).rejects.toThrow('mapping_session_id');
    expect(transport.callService).not.toHaveBeenCalled();
  });

  it('requires an exact saved map version for point navigation modes', async () => {
    const { transport } = makeTransport();
    await expect(setAutonomyMode(transport, {
      desiredMode: AUTONOMY_MODE.SINGLE_POINT_READY,
      mapId: 'map-a',
      mapVersion: 0,
      mapChecksum: 'map-sha',
    })).rejects.toThrow('complete map identity');
    expect(transport.callService).not.toHaveBeenCalled();
  });

  it.each([
    [MAPPING_DISPOSITION.SAVE, true],
    [MAPPING_DISPOSITION.DISCARD, false],
  ] as const)('sends explicit mapping disposition %d', async (disposition, makeCurrent) => {
    const { transport } = makeTransport({ accepted: true });
    await finishMapping(transport, {
      requestId: 'finish-1',
      disposition,
      mapId: 'map-a',
    });

    expect(transport.callService).toHaveBeenCalledWith(
      AUTONOMY_RUNTIME_FINISH_MAPPING_SERVICE,
      AUTONOMY_RUNTIME_FINISH_MAPPING_SERVICE_TYPE,
      expect.objectContaining({
        request_id: 'finish-1',
        disposition,
        map_id: disposition === MAPPING_DISPOSITION.SAVE ? 'map-a' : '',
        make_current: makeCurrent,
      }),
    );
  });

  it('uses a stable APP-session source and monotonically increasing default sequences', async () => {
    const { transport } = makeTransport({ accepted: true });
    await setAutonomyMode(transport, { desiredMode: AUTONOMY_MODE.IDLE });
    await setAutonomyMode(transport, { desiredMode: AUTONOMY_MODE.LOCALIZATION_READY });
    const firstRequest = (transport.callService as jest.Mock).mock.calls[0][2];
    const secondRequest = (transport.callService as jest.Mock).mock.calls[1][2];
    expect(firstRequest.source).toMatch(/^app:omni_deck:/);
    expect(secondRequest.source).toBe(firstRequest.source);
    expect(secondRequest.sequence).toBe(firstRequest.sequence + 1);
  });

  it('finishes the exact route recording operation with an explicit disposition', async () => {
    const { transport } = makeTransport({
      accepted: true,
      operation_id: 'route-save-op',
      runtime_generation: 9,
    });
    await finishRouteRecording(transport, {
      requestId: 'finish-route-1',
      sequence: 91,
      source: 'test-app',
      requestedAt: { sec: 100, nanosec: 0 },
      deadline: { sec: 130, nanosec: 0 },
      recordingOperationId: 'recording-op-7',
      disposition: ROUTE_RECORDING_DISPOSITION.SAVE,
    });
    expect(transport.callService).toHaveBeenCalledWith(
      AUTONOMY_RUNTIME_FINISH_ROUTE_RECORDING_SERVICE,
      AUTONOMY_RUNTIME_FINISH_ROUTE_RECORDING_SERVICE_TYPE,
      {
        request_id: 'finish-route-1',
        sequence: 91,
        source: 'test-app',
        requested_at: { sec: 100, nanosec: 0 },
        deadline: { sec: 130, nanosec: 0 },
        recording_operation_id: 'recording-op-7',
        disposition: ROUTE_RECORDING_DISPOSITION.SAVE,
      },
    );
  });

  it('creates one reusable command envelope with an absolute deadline', () => {
    const envelope = createMissionRequestEnvelope('inspection', 30, 1_000);
    expect(envelope.requestId).toMatch(/^inspection-/);
    expect(envelope.source).toMatch(/^app:omni_deck:/);
    expect(envelope.requestedAt).toEqual({ sec: 1, nanosec: 0 });
    expect(envelope.deadline).toEqual({ sec: 31, nanosec: 0 });
  });

  it('fails closed when an accepted async response omits operation_id', async () => {
    const { transport } = makeTransport({ accepted: true, operation_id: '' });
    await expect(setAutonomyMode(transport, {
      desiredMode: AUTONOMY_MODE.SINGLE_POINT_READY,
      mapId: 'map-a',
      mapVersion: 1,
      mapChecksum: 'map-sha',
    })).resolves.toMatchObject({
      accepted: false,
      reason_text: expect.stringContaining('operation_id'),
    });
  });
});

describe('normalizeAutonomyRuntimeStatus', () => {
  it('fills absent optional text and numeric fields with safe defaults', () => {
    expect(normalizeAutonomyRuntimeStatus({ mode: 1 })).toEqual(expect.objectContaining({
      mode: 1,
      desired_mode: 0,
      phase: 0,
      ready: false,
      reason_text: '',
      map_id: '',
    }));
  });
});

describe('generateMappingMapId', () => {
  it('creates a readable map-prefixed ID without punctuation unsafe for paths', () => {
    const mapId = generateMappingMapId(new Date('2026-09-06T12:34:56.789Z'));
    expect(mapId).toMatch(/^map-20260906T123456Z-[a-z0-9]{4}$/);
    expect(mapId).not.toContain(':');
  });

  it('validates the same path-safe map identifiers as the robot MapStore', () => {
    expect(isValidMapId('factory_a-floor.2')).toBe(true);
    expect(isValidMapId('工厂A')).toBe(false);
    expect(isValidMapId('-factory-a')).toBe(false);
    expect(isValidMapId(`m${'a'.repeat(64)}`)).toBe(false);
  });
});
