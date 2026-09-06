import {
  NAVIGATION_STATE,
  buildNavigationTargetPose,
  type NavigationStatus,
} from '../../lib/navigation';
import { useNavigationStore } from '../../stores/useNavigationStore';

function status(overrides: Partial<NavigationStatus> = {}): NavigationStatus {
  const pose = buildNavigationTargetPose('map', 0, 0, 0, { sec: 1, nanosec: 0 });
  return {
    stamp: null,
    state: NAVIGATION_STATE.IDLE,
    manager_epoch: 'epoch-1',
    status_sequence: 1,
    operation_id: '',
    runtime_generation: 1,
    request_id: '',
    request_sequence: 0,
    request_source: '',
    requested_at: { sec: 0, nanosec: 0 },
    deadline: { sec: 0, nanosec: 0 },
    map_id: '',
    map_version: 0,
    map_checksum: '',
    target_pose: pose,
    current_pose_valid: false,
    current_pose: pose,
    remaining_distance_m: 0,
    reason_code: 0,
    reason_text: '',
    ...overrides,
  };
}

beforeEach(() => useNavigationStore.getState().resetFeed());

describe('useNavigationStore', () => {
  it('keeps only monotonically newer status in one Manager epoch', () => {
    useNavigationStore.getState().onStatus(status({
      status_sequence: 5,
      state: NAVIGATION_STATE.EXECUTING,
      operation_id: 'nav-1',
    }), 100);
    useNavigationStore.getState().onStatus(status({
      status_sequence: 4,
      state: NAVIGATION_STATE.SUCCEEDED,
      operation_id: 'nav-1',
    }), 200);
    expect(useNavigationStore.getState().status?.state).toBe(NAVIGATION_STATE.EXECUTING);
    expect(useNavigationStore.getState().receivedAt).toBe(100);
  });

  it('recovers an active operation from the authoritative snapshot after restart', () => {
    useNavigationStore.getState().onStatus(status({
      manager_epoch: 'epoch-2',
      state: NAVIGATION_STATE.PLANNING,
      operation_id: 'nav-restored',
    }));
    expect(useNavigationStore.getState().activeOperationId).toBe('nav-restored');
  });

  it('serializes submit and cancel and clears the operation on terminal state', () => {
    expect(useNavigationStore.getState().beginSubmit()).toBe(true);
    expect(useNavigationStore.getState().beginCancel()).toBe(false);
    useNavigationStore.getState().completeSubmit({
      accepted: true,
      manager_epoch: 'epoch-1',
      operation_id: 'nav-1',
      runtime_generation: 2,
      reason_code: 0,
      reason_text: '',
    });
    expect(useNavigationStore.getState().beginCancel()).toBe(true);
    useNavigationStore.getState().completeCancel({
      accepted: true,
      manager_epoch: 'epoch-1',
      cancel_operation_id: 'cancel-1',
      reason_code: 0,
      reason_text: '',
    });
    useNavigationStore.getState().onStatus(status({
      status_sequence: 2,
      state: NAVIGATION_STATE.CANCELED,
      operation_id: 'nav-1',
    }));
    expect(useNavigationStore.getState().activeOperationId).toBe('');
    expect(useNavigationStore.getState().canceling).toBe(false);
  });

  it('does not unlock a submit when an unrelated newer heartbeat races the service', () => {
    const targetPose = buildNavigationTargetPose('omni_map', 1, 2, 0, {
      sec: 10,
      nanosec: 0,
    });
    useNavigationStore.getState().setPendingSubmit({
      managerEpoch: 'epoch-1',
      requestId: 'nav-request-1',
      sequence: 7,
      source: 'app:test',
      requestedAt: { sec: 10, nanosec: 0 },
      deadline: { sec: 610, nanosec: 0 },
      mapId: 'warehouse',
      mapVersion: 4,
      mapChecksum: 'sha256:map',
      targetPose,
      useFinalYaw: false,
      speedScale: 0,
    });
    expect(useNavigationStore.getState().beginSubmit()).toBe(true);

    useNavigationStore.getState().onStatus(status({
      status_sequence: 2,
      request_id: 'older-request',
      request_source: 'app:test',
    }));
    expect(useNavigationStore.getState().submitting).toBe(true);
    expect(useNavigationStore.getState().beginSubmit()).toBe(false);

    useNavigationStore.getState().onStatus(status({
      status_sequence: 3,
      state: NAVIGATION_STATE.PLANNING,
      operation_id: 'nav-1',
      request_id: 'nav-request-1',
      request_source: 'app:test',
    }));
    expect(useNavigationStore.getState().submitting).toBe(false);
    expect(useNavigationStore.getState().pendingSubmit).toBeNull();
    expect(useNavigationStore.getState().activeOperationId).toBe('nav-1');
  });

  it('keeps an accepted operation locked across a late pre-submit IDLE snapshot', () => {
    useNavigationStore.getState().setPendingSubmit({
      managerEpoch: 'epoch-1',
      requestId: 'nav-request-1',
      sequence: 7,
      source: 'app:test',
      requestedAt: { sec: 10, nanosec: 0 },
      deadline: { sec: 610, nanosec: 0 },
      mapId: 'warehouse',
      mapVersion: 4,
      mapChecksum: 'sha256:map',
      targetPose: buildNavigationTargetPose('omni_map', 1, 2),
      useFinalYaw: false,
      speedScale: 0,
    });
    expect(useNavigationStore.getState().beginSubmit()).toBe(true);
    useNavigationStore.getState().completeSubmit({
      accepted: true,
      manager_epoch: 'epoch-1',
      operation_id: 'nav-1',
      runtime_generation: 2,
      reason_code: 0,
      reason_text: '',
    });

    useNavigationStore.getState().onStatus(status({
      status_sequence: 2,
      request_id: 'older-request',
      request_source: 'app:test',
    }));
    expect(useNavigationStore.getState().activeOperationId).toBe('nav-1');
    expect(useNavigationStore.getState().pendingSubmit?.requestId)
      .toBe('nav-request-1');
    expect(useNavigationStore.getState().beginSubmit()).toBe(false);

    useNavigationStore.getState().resetFeed();
    expect(useNavigationStore.getState().activeOperationId).toBe('nav-1');

    useNavigationStore.getState().onStatus(status({
      status_sequence: 3,
      state: NAVIGATION_STATE.PLANNING,
      operation_id: 'nav-1',
      request_id: 'nav-request-1',
      request_source: 'app:test',
    }));
    expect(useNavigationStore.getState().pendingSubmit).toBeNull();
    expect(useNavigationStore.getState().activeOperationId).toBe('nav-1');
  });

  it('retains a timed-out envelope only across the same Manager epoch', () => {
    useNavigationStore.getState().setPendingSubmit({
      managerEpoch: 'epoch-1',
      requestId: 'nav-request-1',
      sequence: 7,
      source: 'app:test',
      requestedAt: { sec: 10, nanosec: 0 },
      deadline: { sec: 610, nanosec: 0 },
      mapId: 'warehouse',
      mapVersion: 4,
      mapChecksum: 'sha256:map',
      targetPose: buildNavigationTargetPose('omni_map', 1, 2),
      useFinalYaw: false,
      speedScale: 0,
    });
    useNavigationStore.getState().resetFeed();
    expect(useNavigationStore.getState().pendingSubmit?.requestId)
      .toBe('nav-request-1');

    useNavigationStore.getState().onStatus(status({
      manager_epoch: 'epoch-2',
      status_sequence: 1,
    }));
    expect(useNavigationStore.getState().pendingSubmit).toBeNull();
  });
});
