import {
  AUTONOMY_MODE,
  AUTONOMY_PHASE,
  type AutonomyRuntimeStatus,
} from '../../lib/autonomy-runtime';
import { useAutonomyRuntimeStore } from '../../stores/useAutonomyRuntimeStore';

function runtimeStatus(
  overrides: Partial<AutonomyRuntimeStatus> = {},
): AutonomyRuntimeStatus {
  return {
    stamp: null,
    desired_mode: AUTONOMY_MODE.IDLE,
    mode: AUTONOMY_MODE.IDLE,
    phase: AUTONOMY_PHASE.IDLE,
    slam_state: 1,
    planner_state: 1,
    route_recording_state: 0,
    ready: false,
    mission_active: false,
    manager_epoch: 'epoch-1',
    runtime_generation: 1,
    status_sequence: 1,
    operation_id: '',
    request_id: '',
    request_sequence: 0,
    request_source: '',
    map_id: '',
    map_version: 0,
    map_checksum: '',
    reason_code: 0,
    reason_text: '',
    route_id: '',
    route_point_count: 0,
    route_distance_m: 0,
    route_checksum: '',
    route_has_unsaved_data: false,
    recording_operation_id: '',
    ...overrides,
  };
}

beforeEach(() => {
  useAutonomyRuntimeStore.getState().resetFeed();
  useAutonomyRuntimeStore.getState().setMappingTargetId('');
});

describe('useAutonomyRuntimeStore status ordering', () => {
  it('ignores an older cached snapshot from the same runtime generation', () => {
    useAutonomyRuntimeStore.getState().onStatus(runtimeStatus({
      status_sequence: 8,
      mode: AUTONOMY_MODE.SINGLE_POINT_READY,
    }), 100);
    useAutonomyRuntimeStore.getState().onStatus(runtimeStatus({
      status_sequence: 7,
      mode: AUTONOMY_MODE.IDLE,
    }), 200);

    expect(useAutonomyRuntimeStore.getState().status?.mode)
      .toBe(AUTONOMY_MODE.SINGLE_POINT_READY);
    expect(useAutonomyRuntimeStore.getState().receivedAt).toBe(100);
  });

  it('accepts a lower sequence after Manager epoch changes', () => {
    useAutonomyRuntimeStore.getState().onStatus(runtimeStatus({
      manager_epoch: 'epoch-1',
      status_sequence: 8,
    }));
    useAutonomyRuntimeStore.getState().onStatus(runtimeStatus({
      manager_epoch: 'epoch-2',
      status_sequence: 1,
      mode: AUTONOMY_MODE.MAPPING,
    }));
    expect(useAutonomyRuntimeStore.getState().status?.mode).toBe(AUTONOMY_MODE.MAPPING);
  });

  it('marks a previously synchronized status stale without deleting diagnostics', () => {
    useAutonomyRuntimeStore.getState().onStatus(runtimeStatus({ reason_text: 'waiting' }));
    useAutonomyRuntimeStore.getState().markStale();
    expect(useAutonomyRuntimeStore.getState().stale).toBe(true);
    expect(useAutonomyRuntimeStore.getState().status?.reason_text).toBe('waiting');
  });
});

describe('useAutonomyRuntimeStore command serialization', () => {
  it('keeps an accepted command serialized until its status reaches a terminal phase', () => {
    expect(useAutonomyRuntimeStore.getState().beginCommand({
      kind: 'set_mode',
      desiredMode: AUTONOMY_MODE.MAPPING,
    })).toBe(true);
    expect(useAutonomyRuntimeStore.getState().beginCommand({
      kind: 'finish_mapping',
    })).toBe(false);

    useAutonomyRuntimeStore.getState().completeCommand({
      accepted: true,
      operation_id: 'op-1',
      reason_code: 0,
      reason_text: '',
      runtime_generation: 2,
    });
    expect(useAutonomyRuntimeStore.getState().pendingCommand).toEqual({
      kind: 'set_mode',
      desiredMode: AUTONOMY_MODE.MAPPING,
      operationId: 'op-1',
    });
    expect(useAutonomyRuntimeStore.getState().beginCommand({
      kind: 'finish_mapping',
    })).toBe(false);
    expect(useAutonomyRuntimeStore.getState().lastOperationId).toBe('op-1');

    useAutonomyRuntimeStore.getState().onStatus(runtimeStatus({
      operation_id: 'op-1',
      desired_mode: AUTONOMY_MODE.MAPPING,
      mode: AUTONOMY_MODE.MAPPING,
      phase: AUTONOMY_PHASE.READY,
      ready: true,
    }));
    expect(useAutonomyRuntimeStore.getState().pendingCommand).toBeNull();
  });

  it('keeps a rejected command reason visible', () => {
    useAutonomyRuntimeStore.getState().beginCommand({ kind: 'finish_mapping' });
    useAutonomyRuntimeStore.getState().completeCommand({
      accepted: false,
      operation_id: '',
      reason_code: 9,
      reason_text: 'map validation failed',
      runtime_generation: 2,
    });
    expect(useAutonomyRuntimeStore.getState().lastError).toBe('map validation failed');
  });

  it('keeps FinishRouteRecording serialized until its own operation leaves recording mode', () => {
    useAutonomyRuntimeStore.getState().onStatus(runtimeStatus({
      mode: AUTONOMY_MODE.ROUTE_RECORDING,
      desired_mode: AUTONOMY_MODE.ROUTE_RECORDING,
      phase: AUTONOMY_PHASE.READY,
      ready: true,
      operation_id: 'record-route-1',
      route_id: 'route-a',
    }));
    expect(useAutonomyRuntimeStore.getState().routeRecordingOperationId)
      .toBe('record-route-1');
    expect(useAutonomyRuntimeStore.getState().beginCommand({
      kind: 'finish_route_recording',
    })).toBe(true);
    useAutonomyRuntimeStore.getState().completeCommand({
      accepted: true,
      operation_id: 'finish-route-1',
      reason_code: 0,
      reason_text: '',
      runtime_generation: 3,
    });
    useAutonomyRuntimeStore.getState().onStatus(runtimeStatus({
      status_sequence: 2,
      operation_id: 'finish-route-1',
      mode: AUTONOMY_MODE.ROUTE_RECORDING,
      phase: AUTONOMY_PHASE.ERROR,
      reason_text: 'save failed',
    }));
    expect(useAutonomyRuntimeStore.getState().routeRecordingOperationId)
      .toBe('record-route-1');

    useAutonomyRuntimeStore.getState().onStatus(runtimeStatus({
      status_sequence: 3,
      operation_id: 'finish-route-2',
      mode: AUTONOMY_MODE.IDLE,
      phase: AUTONOMY_PHASE.IDLE,
    }));
    expect(useAutonomyRuntimeStore.getState().pendingCommand).toBeNull();
    expect(useAutonomyRuntimeStore.getState().routeRecordingOperationId).toBe('');
  });

  it('cold-recovers the recording session identity from an ERROR snapshot', () => {
    useAutonomyRuntimeStore.getState().onStatus(runtimeStatus({
      mode: AUTONOMY_MODE.ROUTE_RECORDING,
      desired_mode: AUTONOMY_MODE.IDLE,
      phase: AUTONOMY_PHASE.ERROR,
      operation_id: 'finish-route-1',
      recording_operation_id: 'record-route-1',
      route_id: 'route-a',
      route_has_unsaved_data: true,
      reason_text: 'save failed',
    }));

    expect(useAutonomyRuntimeStore.getState().routeRecordingOperationId)
      .toBe('record-route-1');
    expect(useAutonomyRuntimeStore.getState().status?.operation_id)
      .toBe('finish-route-1');
  });
});
