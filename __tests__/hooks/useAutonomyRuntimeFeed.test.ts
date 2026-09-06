import {
  synchronizeMappingPreview,
} from '../../hooks/useAutonomyRuntimeFeed';
import { AUTONOMY_MODE, AUTONOMY_PHASE } from '../../lib/autonomy-runtime';
import type { AutonomyRuntimeStatus } from '../../lib/autonomy-runtime';
import { useMappingStore } from '../../stores/useMappingStore';

const mockSetActiveLayout = jest.fn();
jest.mock('../../stores/useLayoutStore', () => ({
  useLayoutStore: {
    getState: () => ({
      layouts: [{ id: 'mapping-3d' }],
      setActiveLayout: mockSetActiveLayout,
    }),
  },
}));

function runtime(
  mode: number,
  phase: number = AUTONOMY_PHASE.READY,
): AutonomyRuntimeStatus {
  return {
    stamp: {},
    desired_mode: mode,
    mode,
    phase,
    slam_state: 0,
    planner_state: 0,
    route_recording_state: 0,
    ready: phase === AUTONOMY_PHASE.READY,
    mission_active: false,
    manager_epoch: 'epoch-test',
    runtime_generation: 1,
    status_sequence: 1,
    operation_id: 'operation-test',
    request_id: 'request-test',
    request_sequence: 1,
    request_source: 'test',
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
  };
}

describe('建图运行时到点云预览的投影', () => {
  beforeEach(() => {
    mockSetActiveLayout.mockClear();
    useMappingStore.setState({ active: false, sessionId: 0 });
  });

  it('重连到既有建图会话后恢复 live 状态，重复心跳不重复开会话', () => {
    const status = runtime(AUTONOMY_MODE.MAPPING);
    synchronizeMappingPreview(status);
    synchronizeMappingPreview({ ...status, status_sequence: 2 });

    expect(useMappingStore.getState()).toMatchObject({ active: true, sessionId: 1 });
    expect(mockSetActiveLayout).toHaveBeenCalledTimes(1);
    expect(mockSetActiveLayout).toHaveBeenCalledWith('mapping-3d');
  });

  it('停止、状态过期或断连后结束 live 预览', () => {
    synchronizeMappingPreview(runtime(AUTONOMY_MODE.MAPPING));
    synchronizeMappingPreview(runtime(AUTONOMY_MODE.MAPPING, AUTONOMY_PHASE.STOPPING));
    expect(useMappingStore.getState().active).toBe(false);

    synchronizeMappingPreview(runtime(AUTONOMY_MODE.MAPPING));
    synchronizeMappingPreview(null);
    expect(useMappingStore.getState().active).toBe(false);
  });
});
