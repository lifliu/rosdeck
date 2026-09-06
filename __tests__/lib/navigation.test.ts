import {
  NAVIGATION_CANCEL_SERVICE,
  NAVIGATION_CANCEL_SERVICE_TYPE,
  NAVIGATION_STATE,
  NAVIGATION_STATUS_TOPIC,
  NAVIGATION_STATUS_TYPE,
  NAVIGATION_SUBMIT_SERVICE,
  NAVIGATION_SUBMIT_SERVICE_TYPE,
  buildNavigationTargetPose,
  cancelNavigationGoal,
  submitNavigationGoal,
  subscribeNavigationStatus,
} from '../../lib/navigation';
import { getLocalServiceSchema } from '../../lib/ros-service-schemas';
import type { Transport } from '../../lib/transport';
import { parse as parseMessageDefinition } from '@foxglove/rosmsg';
import { MessageWriter } from '@foxglove/rosmsg2-serialization';

function makeTransport(response: Record<string, unknown> = {}) {
  let callback: ((message: any) => void) | undefined;
  const transport: Transport = {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
    subscribe: jest.fn((_topic, _type, next) => {
      callback = next;
      return { unsubscribe: jest.fn() };
    }),
    publish: jest.fn(),
    callService: jest.fn().mockResolvedValue(response),
    getTopics: jest.fn().mockResolvedValue([]),
    onStatus: jest.fn().mockReturnValue(jest.fn()),
    getStatus: jest.fn().mockReturnValue('connected'),
  };
  return { transport, emit: (message: any) => callback?.(message) };
}

describe('Mission point-navigation facade', () => {
  it('submits a typed, map-bound PoseStamped without publishing a Planner topic', async () => {
    const { transport } = makeTransport({
      accepted: true,
      manager_epoch: 'epoch-1',
      operation_id: 'nav-op-1',
      runtime_generation: 5,
      reason_code: 0,
      reason_text: '',
    });
    const pose = buildNavigationTargetPose(
      'omni_map', 1.25, -0.75, 0,
      { sec: 100, nanosec: 2 },
    );
    const response = await submitNavigationGoal(transport, {
      requestId: 'nav-request-1',
      sequence: 22,
      source: 'test-app',
      requestedAt: { sec: 100, nanosec: 2 },
      deadline: { sec: 400, nanosec: 2 },
      mapId: 'factory-a',
      mapVersion: 3,
      mapChecksum: 'map-sha-3',
      targetPose: pose,
      speedScale: 0.5,
    });

    expect(transport.callService).toHaveBeenCalledWith(
      NAVIGATION_SUBMIT_SERVICE,
      NAVIGATION_SUBMIT_SERVICE_TYPE,
      {
        request_id: 'nav-request-1',
        sequence: 22,
        source: 'test-app',
        requested_at: { sec: 100, nanosec: 2 },
        deadline: { sec: 400, nanosec: 2 },
        map_id: 'factory-a',
        map_version: 3,
        map_checksum: 'map-sha-3',
        target_pose: pose,
        use_final_yaw: false,
        speed_scale: 0.5,
      },
    );
    expect(transport.publish).not.toHaveBeenCalled();
    expect(response).toMatchObject({ accepted: true, operation_id: 'nav-op-1' });
  });

  it('fails closed before transport when map identity is incomplete', async () => {
    const { transport } = makeTransport();
    await expect(submitNavigationGoal(transport, {
      mapId: 'factory-a',
      mapVersion: 0,
      mapChecksum: '',
      targetPose: buildNavigationTargetPose('map', 0, 0),
    })).rejects.toThrow('complete map identity');
    expect(transport.callService).not.toHaveBeenCalled();
  });

  it('rejects a malformed PoseStamped before calling Mission Manager', async () => {
    const { transport } = makeTransport();
    const pose = buildNavigationTargetPose('map', 0, 0);
    pose.pose.position.x = Number.NaN;
    await expect(submitNavigationGoal(transport, {
      mapId: 'factory-a',
      mapVersion: 1,
      mapChecksum: 'map-sha',
      targetPose: pose,
    })).rejects.toThrow('finite PoseStamped');
    expect(transport.callService).not.toHaveBeenCalled();
  });

  it('cancels one explicit navigation operation using a new request identity', async () => {
    const { transport } = makeTransport({
      accepted: true,
      manager_epoch: 'epoch-1',
      cancel_operation_id: 'cancel-op-1',
    });
    await cancelNavigationGoal(transport, {
      requestId: 'cancel-request-1',
      sequence: 23,
      source: 'test-app',
      requestedAt: { sec: 110, nanosec: 0 },
      deadline: { sec: 140, nanosec: 0 },
      targetOperationId: 'nav-op-1',
    });
    expect(transport.callService).toHaveBeenCalledWith(
      NAVIGATION_CANCEL_SERVICE,
      NAVIGATION_CANCEL_SERVICE_TYPE,
      expect.objectContaining({
        target_operation_id: 'nav-op-1',
        request_id: 'cancel-request-1',
        sequence: 23,
      }),
    );
  });

  it('normalizes and filters navigation status snapshots', () => {
    const { transport, emit } = makeTransport();
    const callback = jest.fn();
    subscribeNavigationStatus(transport, callback);
    expect(transport.subscribe).toHaveBeenCalledWith(
      NAVIGATION_STATUS_TOPIC,
      NAVIGATION_STATUS_TYPE,
      expect.any(Function),
    );
    emit({});
    expect(callback).not.toHaveBeenCalled();
    emit({
      state: NAVIGATION_STATE.EXECUTING,
      managerEpoch: 'epoch-1',
      statusSequence: '7',
      operationId: 'nav-op-1',
      remainingDistanceM: 2.5,
      targetPose: {
        header: { stamp: { sec: 1, nanosec: 0 }, frameId: 'omni_map' },
        pose: {
          position: { x: 1, y: 2, z: 0 },
          orientation: { w: 1 },
        },
      },
    });
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      state: NAVIGATION_STATE.EXECUTING,
      manager_epoch: 'epoch-1',
      status_sequence: 7,
      operation_id: 'nav-op-1',
      remaining_distance_m: 2.5,
      target_pose: expect.objectContaining({
        header: expect.objectContaining({ frame_id: 'omni_map' }),
      }),
    }));
  });

  it('registers complete Humble CDR fallback schemas', () => {
    const submitSchema = getLocalServiceSchema(NAVIGATION_SUBMIT_SERVICE_TYPE, 'request');
    expect(submitSchema).toContain('geometry_msgs/msg/PoseStamped target_pose');
    expect(submitSchema).toContain('MSG: geometry_msgs/msg/PoseStamped');
    expect(getLocalServiceSchema(NAVIGATION_CANCEL_SERVICE_TYPE, 'request'))
      .toContain('string target_operation_id');
    const writer = new MessageWriter(parseMessageDefinition(submitSchema!, { ros2: true }));
    expect(() => writer.writeMessage({
      request_id: 'nav-1',
      sequence: 1,
      source: 'test-app',
      requested_at: { sec: 1, nanosec: 0 },
      deadline: { sec: 2, nanosec: 0 },
      map_id: 'map-a',
      map_version: 1,
      map_checksum: 'map-sha',
      target_pose: buildNavigationTargetPose('map', 1, 2),
      use_final_yaw: false,
      speed_scale: 0,
    })).not.toThrow();
  });
});
